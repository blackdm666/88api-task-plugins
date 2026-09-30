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
	assert.Equal(t, "1.0.1", plugin.Meta.Version)
	assert.True(t, plugin.Meta.DynamicModels)
	assert.Empty(t, plugin.Meta.Models)

	decoded, err := plugin.Engine.CallPath(context.Background(), "protocols",
		[]string{"openai_video", "decodeRequest"}, map[string]any{
			"model": "doubao-seedance-2-5-260628",
			"body": map[string]any{"kind": "json", "value": map[string]any{
				"prompt": "Fixture", "duration": -1, "ratio": "adaptive",
				"resolution": "720p", "images": []any{"https://example.invalid/image.png"},
			}},
		})
	require.NoError(t, err)
	requestBody := decoded.(map[string]any)["requestBody"].(map[string]any)
	assert.Equal(t, "doubao-seedance-2-5-260628", requestBody["model"])
	assert.EqualValues(t, -1, requestBody["duration"])
	assert.Equal(t, "adaptive", requestBody["ratio"])
	assert.Equal(t, "image_url", requestBody["content"].([]any)[1].(map[string]any)["type"])

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
