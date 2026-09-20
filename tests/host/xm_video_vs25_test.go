package jsplugin

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestXinMengVS25MappedSales(t *testing.T) {
	source, err := os.ReadFile("../../plugins/tasks/xm-video/plugin.js")
	require.NoError(t, err)
	plugin, err := NewRegistry().Register(string(source), Options{})
	require.NoError(t, err)
	call := func(hook string, args ...any) map[string]any {
		t.Helper()
		result, err := plugin.Engine.Call(context.Background(), hook, args...)
		require.NoError(t, err)
		return result.(map[string]any)
	}
	for _, quality := range []string{"480p", "720p", "1080p"} {
		t.Run(quality, func(t *testing.T) {
			model := "SD2.5 " + strings.ToUpper(quality)
			for _, ratio := range []string{"9:16", "21:9"} {
				input := map[string]any{
					"prompt": "Fixture", "seconds": "30", "generateAudio": false,
					"metadata": map[string]any{"resolution": "4k", "ratio": ratio},
				}
				decoded := call("decodeRequest", map[string]any{
					"model": model, "body": map[string]any{"kind": "json", "value": input},
				})
				driver := map[string]any{
					"model": model, "upstreamModel": "lltai-vs-2.5",
					"requestBody": decoded["requestBody"], "baseUrl": "https://example.invalid",
				}
				body := call("buildSubmitRequest", driver)["body"].(map[string]any)
				assert.Equal(t, ratio, body["ratio"])
				assert.Equal(t, quality, body["resolution"])
				assert.Equal(t, "lltai-vs-2.5", body["model"])
				assert.Equal(t, false, body["generateAudio"])
				assert.EqualValues(t, 30, body["duration"])
				assert.Equal(t, body["duration"], call("extractUsage", driver)["seconds"])
				assert.Equal(t, model, decoded["model"])
				driver["upstreamModel"] = "dvc-seedance-2.5"
				legacy := call("buildSubmitRequest", driver)["body"].(map[string]any)
				assert.Equal(t, ratio, legacy["ratio"])
			}
			for _, value := range []map[string]any{
				{"prompt": "Fixture", "seconds": "30"},
				{"prompt": "Fixture", "seconds": "30", "ratio": "auto"},
			} {
				decoded := map[string]any{"model": model, "body": map[string]any{
					"kind": "json", "value": value,
				}}
				decodedValue, err := plugin.Engine.CallPath(context.Background(), "protocols",
					[]string{"openai_video", "decodeRequest"}, decoded)
				require.NoError(t, err)
				requestBody := decodedValue.(map[string]any)["requestBody"]
				_, err = plugin.Engine.Call(context.Background(), "buildSubmitRequest", map[string]any{
					"model": model, "upstreamModel": "lltai-vs-2.5",
					"requestBody": requestBody, "baseUrl": "https://example.invalid",
				})
				assert.Error(t, err)
			}
		})
	}
}
