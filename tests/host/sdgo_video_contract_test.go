package jsplugin

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIndependentPluginCatalogueSDGOVideoContract(t *testing.T) {
	root := filepath.Clean("../../..")
	source, err := os.ReadFile(filepath.Join(root, "plugins", "sdgo-video", "plugin.js"))
	require.NoError(t, err)
	plugin, err := NewRegistry().Register(string(source), Options{})
	require.NoError(t, err)
	assert.Equal(t, "sdgo-video", plugin.Meta.Key)
	assert.Equal(t, "SD-Video", plugin.Meta.Name)
	assert.Equal(t, "1.0.8", plugin.Meta.Version)
	assert.True(t, plugin.Meta.DynamicModels)
	assert.Equal(t, []string{
		"doubao-seedance-2-0-mini-260615",
		"doubao-seedance-2-0-260128",
		"doubao-seedance-2-0-fast-260128",
		"doubao-seedance-2-5-260628",
	}, plugin.Meta.Models)
	require.Len(t, plugin.Meta.UsageProfiles, 3)

	decoded, err := plugin.Engine.CallPath(context.Background(), "protocols",
		[]string{"openai_video", "decodeRequest"}, map[string]any{
			"model": "doubao-seedance-2-5-260628",
			"body": map[string]any{"kind": "json", "value": map[string]any{
				"prompt": "Fixture", "duration": -1, "ratio": "adaptive",
				"resolution": "720p",
				"images": []any{"https://example.invalid/image.png"},
				"videos": []any{"https://example.invalid/video.mp4"},
			}},
		})
	require.NoError(t, err)
	requestBody := decoded.(map[string]any)["requestBody"].(map[string]any)
	assert.Equal(t, "doubao-seedance-2-5-260628", requestBody["model"])
	assert.EqualValues(t, -1, requestBody["duration"])
	assert.Equal(t, "adaptive", requestBody["ratio"])
	assert.Equal(t, "image_url", requestBody["content"].([]any)[1].(map[string]any)["type"])

	assetDecoded, err := plugin.Engine.CallPath(context.Background(), "protocols",
		[]string{"openai_video", "decodeRequest"}, map[string]any{
			"model": "doubao-seedance-2-5-260628",
			"body": map[string]any{"kind": "json", "value": map[string]any{
				"prompt": "Asset fixture",
				"content": []any{
					map[string]any{"type": "text", "text": "Asset fixture"},
					map[string]any{
						"type": "image_url", "role": "reference_image",
						"image_url": map[string]any{"url": "tos://bucket/image.png"},
					},
					map[string]any{
						"type": "video_url", "role": "reference_video",
						"video_url": map[string]any{"url": "asset://video-asset-1"},
					},
				},
			}},
		})
	require.NoError(t, err)
	assetBody := assetDecoded.(map[string]any)["requestBody"].(map[string]any)
	assert.Equal(t, "asset", assetBody["image_source_mode"])
	assert.Equal(t, "asset", assetBody["video_source_mode"])

	value, err := plugin.Engine.Call(context.Background(), "buildSubmitRequest", map[string]any{
		"model": "doubao-seedance-2-5-260628",
		"upstreamModel": "doubao-seedance-2-5-260628",
		"baseUrl": "https://sdgo.top/api/v3",
		"apiKey": "fixture",
		"requestBody": requestBody,
	})
	require.NoError(t, err)
	request := value.(map[string]any)
	assert.Equal(t, "https://sdgo.top/api/v3/contents/generations/tasks", request["url"])
	assert.Equal(t, "Bearer fixture", request["headers"].(map[string]any)["Authorization"])

	submitResult, err := plugin.Engine.Call(context.Background(), "parseSubmitResponse",
		map[string]any{"requestBody": requestBody},
		map[string]any{"body": map[string]any{"id": "task-fixture", "status": "queued"}},
	)
	require.NoError(t, err)
	assert.Equal(t, "present", submitResult.(map[string]any)["state"].(map[string]any)["video_input"])

	result, err := plugin.Engine.Call(context.Background(), "parseTaskResult",
		map[string]any{}, map[string]any{
			"id": "cgt-fixture",
			"status": "succeeded",
			"duration": 10,
			"content": map[string]any{"video_url": "https://example.invalid/video.mp4"},
			"usage": map[string]any{"completion_tokens": 216900, "total_tokens": 216900},
		})
	require.NoError(t, err)
	parsed := result.(map[string]any)
	assert.Equal(t, "SUCCESS", parsed["status"])
	assert.Equal(t, "https://example.invalid/video.mp4", parsed["url"])
	assert.EqualValues(t, 216900, parsed["completionTokens"])
}
