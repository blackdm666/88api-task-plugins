package jsplugin

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// This file runs inside the pinned NewAPI checkout prepared by the CI helper.
func TestIndependentPluginCatalogue(t *testing.T) {
	root := filepath.Clean("../../..")
	payload, err := os.ReadFile(filepath.Join(root, ".publish", "index.json"))
	require.NoError(t, err)
	var index struct {
		Plugins []struct {
			Key, Name, Latest string
			Versions          []struct{ Version, SHA256 string }
		}
	}
	require.NoError(t, common.Unmarshal(payload, &index))
	require.NotEmpty(t, index.Plugins)
	registry := NewRegistry()
	for _, item := range index.Plugins {
		t.Run(item.Key, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(root, "plugins", item.Key, "plugin.js"))
			require.NoError(t, err)
			source := strings.ReplaceAll(string(data), "\r\n", "\n")
			plugin, err := registry.Register(source, Options{})
			require.NoError(t, err)
			assert.Equal(t, item.Key, plugin.Meta.Key)
			assert.Equal(t, item.Name, plugin.Meta.Name)
			assert.Equal(t, item.Latest, plugin.Meta.Version)
			assert.Equal(t, 1, plugin.Meta.APIVersion)
			require.NotEmpty(t, item.Versions)
			assert.Equal(t, item.Latest, item.Versions[0].Version)
			assert.Equal(t, fmt.Sprintf("%x", sha256.Sum256([]byte(source))), item.Versions[0].SHA256)
			// Usage examples render as a "price examples" table on the model
			// square. Only token-unit schemas keep them, because the host
			// requires at least one there.
			schemas := []UsageProfile{{Schema: plugin.Meta.UsageSchema, Examples: plugin.Meta.UsageExamples}}
			schemas = append(schemas, plugin.Meta.UsageProfiles...)
			for index, profile := range schemas {
				if !usageSchemaHasTokenUnit(profile.Schema) {
					assert.Empty(t, profile.Examples, "usage profile %d", index)
				}
			}
		})
	}
}

// Exercise the shipped DMC H3 source in the actual JS runtime, not only Node.
// The pinned host still wraps HookError.Error(); the public message is Message.
func TestIndependentPluginCatalogueMinimaxMessages(t *testing.T) {
	source, err := os.ReadFile("../../plugins/tasks/minimax-h3/plugin.js")
	require.NoError(t, err)
	plugin, err := NewRegistry().Register(string(source), Options{})
	require.NoError(t, err)
	for _, tc := range []struct {
		name, hook, want string
		args             []any
	}{
		{
			name: "duration", hook: "buildSubmitRequest",
			args: []any{map[string]any{
				"model": "minimax-h3-768p", "baseUrl": "https://example.invalid",
				"requestBody": map[string]any{"prompt": "Fixture", "duration": 1.5},
			}},
			want: "视频时长需为 1 到 15 秒之间的整数，请调整后提交。",
		},
		{
			name: "usage validation", hook: "extractUsage",
			args: []any{map[string]any{
				"upstreamModel": "MiniMax-H3", "requestBody": map[string]any{"duration": 16},
			}},
			want: "视频时长需为 1 到 15 秒之间的整数，请调整后提交。",
		},
		{
			name: "submit missing ID", hook: "parseSubmitResponse",
			args: []any{map[string]any{}, map[string]any{"body": map[string]any{}}},
			want: "视频服务未返回任务编号，请联系管理员确认是否已受理，勿重复提交。",
		},
		{
			name: "query missing task", hook: "parseTaskResult",
			args: []any{map[string]any{}, map[string]any{}},
			want: "暂未获取到视频任务信息，请稍后查询，无需重新提交生成。",
		},
		{
			name: "upstream unchanged", hook: "parseSubmitResponse",
			args: []any{map[string]any{}, map[string]any{"body": map[string]any{
				"error": map[string]any{"type": "provider_error", "message": "Keep original 错误 detail"},
			}}},
			want: "provider_error: Keep original 错误 detail",
		},
		{
			name: "upstream transient unchanged", hook: "parseTaskResult",
			args: []any{map[string]any{}, map[string]any{
				"error": map[string]any{"type": "provider_busy", "message": "Please wait", "http_code": 503},
			}},
			want: "provider_busy: Please wait",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := plugin.Engine.Call(context.Background(), tc.hook, tc.args...)
			require.Error(t, err)
			var hookErr *HookError
			require.True(t, errors.As(err, &hookErr))
			assert.Equal(t, tc.want, hookErr.Message)
		})
	}

	decoded, err := plugin.Engine.CallPath(context.Background(), "protocols",
		[]string{"openai_video", "decodeRequest"}, map[string]any{
			"model": "minimax-h3-768p",
			"body": map[string]any{"kind": "json", "value": map[string]any{
				"prompt": "Fixture", "seconds": "15", "ratio": "9:16",
			}},
		})
	require.NoError(t, err)
	driver := map[string]any{
		"model": "minimax-h3-768p", "upstreamModel": "MiniMax-H3",
		"baseUrl": "https://example.invalid", "publicTaskId": "public-fixture",
		"requestBody": decoded.(map[string]any)["requestBody"],
	}
	value, err := plugin.Engine.Call(context.Background(), "buildSubmitRequest", driver)
	require.NoError(t, err)
	request := value.(map[string]any)
	assert.Equal(t, "https://example.invalid/v2/video_generation", request["url"])
	assert.Equal(t, "public-fixture", request["headers"].(map[string]any)["Idempotency-Key"])
	body := request["body"].(map[string]any)
	assert.Equal(t, "MiniMax-H3", body["model"])
	assert.Equal(t, "9:16", body["ratio"])
	assert.Equal(t, "768P", body["resolution"])
	assert.EqualValues(t, 15, body["duration"])
	usage, err := plugin.Engine.Call(context.Background(), "extractUsage", driver)
	require.NoError(t, err)
	assert.EqualValues(t, 15, usage.(map[string]any)["seconds"])
	assert.Equal(t, "768p", usage.(map[string]any)["output_resolution"])

	for _, tc := range []struct {
		status, wantStatus, progress, reason string
	}{
		{"queued", "QUEUED", "0%", ""},
		{"running", "IN_PROGRESS", "99%", ""},
		{"failed", "FAILURE", "100%", "视频生成失败，服务端未提供具体原因，请联系管理员。"},
		{"cancelled", "FAILURE", "100%", "视频任务已取消。"},
	} {
		t.Run(tc.status, func(t *testing.T) {
			value, err := plugin.Engine.Call(context.Background(), "parseTaskResult",
				map[string]any{}, map[string]any{"task": map[string]any{"status": tc.status, "progress": 1}})
			require.NoError(t, err)
			result := value.(map[string]any)
			assert.Equal(t, tc.wantStatus, result["status"])
			assert.Equal(t, tc.progress, result["progress"])
			if tc.reason != "" {
				assert.Equal(t, tc.reason, result["reason"])
			}
		})
	}
}
