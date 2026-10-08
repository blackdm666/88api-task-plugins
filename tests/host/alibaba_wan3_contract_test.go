package jsplugin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIndependentPluginCatalogueAlibabaWan3(t *testing.T) {
	source, err := os.ReadFile("../../plugins/tasks/alibaba/plugin.js")
	require.NoError(t, err)
	plugin, err := NewRegistry().Register(string(source), Options{})
	require.NoError(t, err)
	require.Equal(t, "1.4.2", plugin.Meta.Version)
	for _, model := range []string{"wan3.0-video", "wan3.0-video-prime"} {
		t.Run(model, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, "/api/v1/services/aigc/video-generation/video-synthesis", r.URL.Path)
				assert.Equal(t, "enable", r.Header.Get("X-DashScope-Async"))
				var body struct {
					Model      string `json:"model"`
					Parameters struct {
						Ratio      string `json:"ratio"`
						Resolution string `json:"resolution"`
						Duration   int    `json:"duration"`
					} `json:"parameters"`
				}
				require.NoError(t, common.DecodeJson(r.Body, &body))
				assert.Equal(t, model, body.Model)
				assert.Equal(t, "21:9", body.Parameters.Ratio)
				assert.Equal(t, "480P", body.Parameters.Resolution)
				assert.Equal(t, 2, body.Parameters.Duration)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"output":{"task_status":"SUCCEEDED","video_url":"https://example.invalid/output.mp4"},"usage":{"input_video_duration":0,"output_video_duration":2,"SR":480}}`))
			}))
			defer server.Close()
			decoded, err := plugin.Engine.CallPath(context.Background(), "protocols", []string{"openai_video", "decodeRequest"}, map[string]any{
				"model": model, "body": map[string]any{"kind": "json", "value": map[string]any{
					"model": model, "prompt": "Boat", "seconds": 2, "resolution": "480P", "ratio": "21:9",
				}},
			})
			require.NoError(t, err)
			ctx := map[string]any{
				"model": model, "upstreamModel": model, "baseUrl": server.URL, "apiKey": "fixture",
				"requestBody": decoded.(map[string]any)["requestBody"],
			}
			value, err := plugin.Engine.Call(context.Background(), "buildSubmitRequest", ctx)
			require.NoError(t, err)
			request := value.(map[string]any)
			payload, err := common.Marshal(request["body"])
			require.NoError(t, err)
			req, err := http.NewRequest(http.MethodPost, request["url"].(string), strings.NewReader(string(payload)))
			require.NoError(t, err)
			for key, value := range request["headers"].(map[string]any) {
				req.Header.Set(key, value.(string))
			}
			response, err := server.Client().Do(req)
			require.NoError(t, err)
			defer response.Body.Close()
			require.Equal(t, http.StatusOK, response.StatusCode)
			var body map[string]any
			require.NoError(t, common.DecodeJson(response.Body, &body))
			result, err := plugin.Engine.Call(context.Background(), "parseTaskResult", ctx, body)
			require.NoError(t, err)
			assert.Equal(t, "SUCCESS", result.(map[string]any)["status"])
			facts, err := plugin.Engine.Call(context.Background(), "extractUsageOnComplete", ctx, map[string]any{}, body)
			require.NoError(t, err)
			assert.EqualValues(t, 2, facts.(map[string]any)["seconds"])
			assert.Equal(t, "480P", facts.(map[string]any)["resolution"])
		})
	}
	for _, model := range []string{"wan2.7-t2v", "wan2.6-t2v"} {
		_, err := plugin.Engine.Call(context.Background(), "buildSubmitRequest", map[string]any{
			"model": model, "baseUrl": "https://example.invalid", "requestBody": map[string]any{
				"model": model, "prompt": "Boat", "duration": 5, "resolution": "720P", "ratio": "21:9",
			},
		})
		require.Error(t, err)
	}
}
