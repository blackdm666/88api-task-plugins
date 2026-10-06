package jsplugin

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestIndependentPluginCatalogueSeedreamProContract(t *testing.T) {
	source, err := os.ReadFile("../../plugins/seedream-pro/plugin.js")
	require.NoError(t, err)

	plugin, err := NewRegistry().Register(string(source), Options{})
	require.NoError(t, err)
	assert.Equal(t, "seedream-pro", plugin.Meta.Key)
	assert.Equal(t, "1.1.7", plugin.Meta.Version)
	assert.Empty(t, plugin.Meta.UsageExamples)

	decoded, err := plugin.Engine.CallPath(context.Background(), "protocols",
		[]string{"openai_image", "decodeRequest"}, map[string]any{
			"model": "doubao-seedream-5-0-pro",
			"body": map[string]any{
				"kind": "json",
				"value": map[string]any{
					"prompt": "Fixture",
					"size":   "1K",
					"n":      1,
				},
			},
		})
	require.NoError(t, err)

	decodedBody := decoded.(map[string]any)["requestBody"].(map[string]any)
	usage, err := plugin.Engine.Call(context.Background(), "extractUsage",
		map[string]any{"requestBody": decodedBody})
	require.NoError(t, err)
	assert.EqualValues(t, 1, usage.(map[string]any)["image_count"])
	assert.Equal(t, "1K", usage.(map[string]any)["quality"])
	assert.Equal(t, "1K", usage.(map[string]any)["size"])
}
