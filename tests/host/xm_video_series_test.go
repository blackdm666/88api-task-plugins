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

// Series names bill the tier the request selects. The host validates every
// request key named like a usage field against the declared enum, so the
// plugin must store only canonical tier keys under "resolution".
func TestIndependentPluginCatalogueXinMengSeriesResolution(t *testing.T) {
	source, err := os.ReadFile("../../../../plugins/tasks/xm-video/plugin.js")
	require.NoError(t, err)
	plugin, err := pluginruntime.NewRegistry().Register(string(source), pluginruntime.Options{})
	require.NoError(t, err)

	run := func(model, upstream string, request map[string]any, decode bool) (map[string]any, map[string]any, error) {
		t.Helper()
		if decode {
			decoded, err := plugin.Engine.CallPath(context.Background(), "protocols", []string{"openai_video", "decodeRequest"},
				map[string]any{"model": model, "body": map[string]any{"kind": "json", "value": request}})
			require.NoError(t, err)
			request = decoded.(map[string]any)["requestBody"].(map[string]any)
		}
		info := &relaycommon.RelayInfo{
			OriginModelName: model,
			ChannelMeta: &relaycommon.ChannelMeta{ChannelType: constant.ChannelTypeTaskPlugin,
				ChannelBaseUrl: "https://example.invalid", ApiKey: "fixture", UpstreamModelName: upstream},
			TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_seriesfixture"},
		}
		adaptor := New(plugin)
		adaptor.Init(info)
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/v1/videos", strings.NewReader(`{}`))
		c.Set("task_request", request)
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
		model, upstream, resolution, wireModel, wireQuality, billed string
	}{
		{"SD2.5", "lltai-vs-2.5", "1080P", "lltai-vs-2.5", "1080p", "1080p"},
		{"SD2.5", "lltai-vs-2.5", "", "lltai-vs-2.5", "480p", "480p"},
		{"SD2.0", "lltai-vs-2.0", "4K", "lltai-vs-2.0", "4K", "4k"},
		{"kling-3.0-turbo", "kling-3.0-turbo", "2K", "kling-3.0-turbo", "2k", "2k"},
		{"seedance-2.0-mini官方版", "seedance-2.0-mini官方版", "720P", "seedance-2.0-mini-720p", "720p", "720p"},
		{"seedance-2.0官方版", "seedance-2.0官方版", "", "doubao-seedance-2-0-720p", "720p", "720p"},
		{"SD2.0 4K", "lltai-vs-2.0", "480P", "lltai-vs-2.0", "4K", "4k"},
		{"kling-3.0-turbo-1080p", "kling-3.0-turbo", "4k", "kling-3.0-turbo", "1080p", "1080p"},
	} {
		t.Run(tc.model+"/"+tc.resolution, func(t *testing.T) {
			request := map[string]any{"prompt": "Fixture", "duration": 6, "ratio": "16:9"}
			if tc.resolution != "" {
				request["resolution"] = tc.resolution
				request["metadata"] = map[string]any{"resolution": tc.resolution}
			}
			body, facts, err := run(tc.model, tc.upstream, request, true)
			require.NoError(t, err)
			assert.Equal(t, tc.wireModel, body["model"])
			assert.Equal(t, tc.wireQuality, body["resolution"])
			assert.EqualValues(t, 6, body["duration"])
			assert.EqualValues(t, 6, facts["seconds"])
			assert.Equal(t, tc.billed, facts["resolution"])
		})
	}

	// Negative control: a raw non-canonical value is what the host rejects.
	_, _, err = run("SD2.5", "lltai-vs-2.5", map[string]any{"prompt": "Fixture", "duration": 6, "ratio": "16:9", "resolution": "1080P"}, false)
	assert.ErrorContains(t, err, "plugin_usage_invalid")

	// Unsupported tiers fail before any quota or upstream call.
	_, _, err = run("seedance-2.0-mini官方版", "seedance-2.0-mini官方版",
		map[string]any{"prompt": "Fixture", "duration": 6, "ratio": "16:9", "resolution": "1080p"}, false)
	assert.ErrorContains(t, err, "当前模型支持的分辨率：480P、720P")

	// Unknown dynamic models keep passing the requested quality upstream unbilled.
	body, facts, err := run("future-video", "future-video",
		map[string]any{"prompt": "Fixture", "duration": 7, "metadata": map[string]any{"resolution": "4K"}}, true)
	require.NoError(t, err)
	assert.Equal(t, "4K", body["resolution"])
	assert.NotContains(t, facts, "resolution")

	// A tier outside the series profile never reaches quota calculation.
	_, _, err = run("SD2.5", "lltai-vs-2.5", map[string]any{"prompt": "Fixture", "duration": 6, "ratio": "16:9", "resolution": "768p"}, false)
	assert.Error(t, err)
}

// The model square renders one price column per enum value, so each series
// must carry only the tiers it sells. Runtime billing resolves the same profile
// through the channel's upstream mapping; legacy names keep the superset.
func TestIndependentPluginCatalogueXinMengSeriesUsageProfiles(t *testing.T) {
	source, err := os.ReadFile("../../../../plugins/tasks/xm-video/plugin.js")
	require.NoError(t, err)
	plugin, err := pluginruntime.NewRegistry().Register(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	assert.True(t, plugin.Meta.DynamicModels)

	enum := func(models ...string) []string {
		schema, _ := plugin.Meta.UsageForModels(models...)
		return schema["resolution"].Enum
	}
	superset := []string{"480p", "720p", "768p", "1080p", "2k", "4k"}
	for model, tiers := range map[string][]string{
		"SD2.5":                {"480p", "720p", "1080p"},
		"SD2.0":                {"480p", "720p", "1080p", "4k"},
		"kling-3.0-turbo":      {"720p", "1080p", "2k", "4k"},
		"seedance-2.0-mini官方版": {"480p", "720p"},
		"seedance-2.5官方版":      {"720p"},
		"seedance-2.0官方版":      {"720p"},
		"seedance-2.0-fast官方版": {"720p"},
	} {
		assert.Contains(t, plugin.Meta.Models, model)
		assert.Equal(t, tiers, enum(model), model)
	}
	assert.Equal(t, []string{"480p", "720p", "1080p"}, enum("lltai-vs-2.5", "SD2.5"), "mapped upstream IDs keep the series profile")
	assert.Equal(t, []string{"480p", "720p", "1080p", "4k"}, enum("lltai-vs-2.0", "SD2.0"))
	for _, legacy := range []string{"SD2.5 480P", "SD2.0 4K", "kling-3.0-turbo-4k", "seedance-2.0-mini-720p", "Seedance-2.5-720p官方版", "future-video"} {
		assert.Equal(t, superset, enum(legacy), legacy)
		assert.NotContains(t, plugin.Meta.Models, legacy)
	}
}
