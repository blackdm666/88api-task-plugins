package jsplugin

import (
	"crypto/sha256"
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
		})
	}
}
