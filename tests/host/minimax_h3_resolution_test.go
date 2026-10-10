package jsplugin

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The model square renders one price column per enum value, so H3 bills an
// output_resolution tier. The fact is deliberately not named "resolution": the
// host validates request keys named like usage fields before buildSubmit, and a
// sold name mapped to the H3 alias decodes without knowing it is H3.
func TestIndependentPluginCatalogueMinimaxResolution(t *testing.T) {
	source, err := os.ReadFile("../../../../plugins/tasks/minimax-h3/plugin.js")
	require.NoError(t, err)
	plugin, err := pluginruntime.NewRegistry().Register(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	assert.Empty(t, plugin.Meta.Models)
	assert.Empty(t, plugin.Meta.UsageProfiles)
	assert.Equal(t, []string{"768p"}, plugin.Meta.UsageSchema["output_resolution"].Enum)
	assert.Empty(t, plugin.Meta.UsageExamples)

	run := func(model, upstream string, request map[string]any) (map[string]any, map[string]any, error) {
		t.Helper()
		decoded, err := plugin.Engine.CallPath(context.Background(), "protocols", []string{"openai_video", "decodeRequest"},
			map[string]any{"model": model, "body": map[string]any{"kind": "json", "value": request}})
		if err != nil {
			return nil, nil, err
		}
		info := &relaycommon.RelayInfo{
			OriginModelName: model,
			ChannelMeta: &relaycommon.ChannelMeta{ChannelType: constant.ChannelTypeTaskPlugin,
				ChannelBaseUrl: "https://example.invalid", ApiKey: "fixture", UpstreamModelName: upstream},
			TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_h3resolution"},
		}
		adaptor := New(plugin)
		adaptor.Init(info)
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/v1/videos", strings.NewReader(`{}`))
		c.Set("task_request", decoded.(map[string]any)["requestBody"])
		if taskErr := adaptor.ValidateRequestAndSetAction(c, info); taskErr != nil {
			return nil, nil, fmt.Errorf("%s: %s %v", taskErr.Code, taskErr.Message, taskErr.Error)
		}
		facts, err := adaptor.ExtractUsageFactsValidated(c, info)
		require.NoError(t, err)
		reader, err := adaptor.BuildRequestBody(c, info)
		require.NoError(t, err)
		raw, err := io.ReadAll(reader)
		require.NoError(t, err)
		var body map[string]any
		require.NoError(t, common.Unmarshal(raw, &body))
		return body, facts, nil
	}

	for _, tc := range []struct {
		name, model, upstream string
		request               map[string]any
	}{
		{"declared alias, default", "minimax-h3-768p", "minimax-h3-768p", map[string]any{}},
		{"declared alias, uppercase", "minimax-h3-768p", "minimax-h3-768p",
			map[string]any{"resolution": "768P", "metadata": map[string]any{"resolution": "768P"}}},
		{"mapped sale name, uppercase", "dynamic-sale", "dmc-minimax-h3", map[string]any{"resolution": "768P"}},
		{"mapped sale name, pixel size", "dynamic-sale", "dmc-minimax-h3", map[string]any{"size": "1366x768"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := map[string]any{"prompt": "Fixture", "duration": 6, "ratio": "16:9"}
			for key, value := range tc.request {
				request[key] = value
			}
			body, facts, err := run(tc.model, tc.upstream, request)
			require.NoError(t, err)
			assert.Equal(t, "MiniMax-H3", body["model"])
			assert.Equal(t, "768P", body["resolution"])
			assert.EqualValues(t, 6, body["duration"])
			assert.EqualValues(t, 6, facts["seconds"])
			assert.Equal(t, "768p", facts["output_resolution"])
		})
	}

	// Unsupported tiers fail with Chinese guidance before quota or upstream calls.
	_, _, err = run("dynamic-sale", "dmc-minimax-h3", map[string]any{"prompt": "Fixture", "duration": 6, "resolution": "1080p"})
	assert.ErrorContains(t, err, "当前模型仅支持 768P 分辨率，请选择 768P。")

	// Other upstream models keep forwarding the requested value unbilled.
	body, facts, err := run("future-model", "future-model", map[string]any{"prompt": "Fixture", "duration": 7, "resolution": "1080P"})
	require.NoError(t, err)
	assert.Equal(t, "1080P", body["resolution"])
	assert.NotContains(t, facts, "output_resolution")
}
