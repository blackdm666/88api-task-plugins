package controller

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	relaychannel "github.com/QuantumNous/new-api/relay/channel"
	taskjsplugin "github.com/QuantumNous/new-api/relay/channel/task/jsplugin"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Execute the independent source in Sobek, validate its descriptor through the
// real task adaptor, and stream through the real controller to a protected
// fixture upstream. No production requests or paid generation are used.
func TestIndependentPluginCatalogueGrokVideoContentHTTP(t *testing.T) {
	task := setupGenericTaskTest(t)
	allowPrivateTaskMediaTest(t)
	payload := []byte("\x00\x00\x00\x18ftypmp42fixture-video")
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer fixture-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		// Sub2API does not register a HEAD content route. This fixture must not
		// hide that incompatibility by accepting a generic HTTP server's HEAD.
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		assert.Equal(t, "/v1/videos/upstream/content", r.URL.Path)
		w.Header().Set("Content-Type", "video/mp4")
		http.ServeContent(w, r, "fixture.mp4", time.Time{}, bytes.NewReader(payload))
	}))
	defer upstream.Close()
	require.NoError(t, model.DB.Model(&model.Channel{}).Where("id = ?", task.ChannelId).
		Updates(map[string]any{"base_url": upstream.URL, "type": constant.ChannelTypeTaskPlugin, "key": "fixture-secret"}).Error)
	source, err := os.ReadFile("../../plugins/grok-video/plugin.js")
	require.NoError(t, err)
	plugin, err := pluginruntime.NewRegistry().Register(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	adaptor := taskjsplugin.New(plugin)
	adaptor.Init(&relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{
		ChannelType: constant.ChannelTypeTaskPlugin, ChannelBaseUrl: upstream.URL, ApiKey: "fixture-secret",
	}})
	task.PrivateData.Execution = &model.TaskExecutionSnapshot{
		TaskPlugin: &model.TaskPluginSnapshot{Key: "grok-video", Version: "1.0.2"},
	}
	for _, resultURL := range []string{"/v1/videos/upstream/content", upstream.URL + "/v1/videos/upstream/content"} {
		task.Data, err = common.Marshal(map[string]any{"status": "done", "video": map[string]any{"url": resultURL}})
		require.NoError(t, err)
		for _, tc := range []struct {
			method, rangeHeader string
			status              int
			body                []byte
		}{
			{http.MethodGet, "", http.StatusOK, payload},
			{http.MethodGet, "bytes=0-7", http.StatusPartialContent, payload[:8]},
			{http.MethodHead, "", http.StatusOK, nil},
		} {
			t.Run(resultURL+"-"+tc.method+"-"+tc.rangeHeader, func(t *testing.T) {
				descriptor, err := adaptor.BuildContentRequest(task, "video", relaychannel.TaskArtifactClientRequest{Method: tc.method})
				require.NoError(t, err)
				assert.False(t, descriptor.Credentialless)
				assert.Equal(t, http.MethodGet, descriptor.Method)
				assert.Equal(t, "Bearer fixture-secret", descriptor.Headers["Authorization"])
				recorder := httptest.NewRecorder()
				c, _ := gin.CreateTestContext(recorder)
				c.Request = httptest.NewRequest(tc.method, "/v1/tasks/task_generic/artifacts/video/content", nil)
				if tc.rangeHeader != "" {
					c.Request.Header.Set("Range", tc.rangeHeader)
				}
				require.NoError(t, proxyTaskMedia(c, task, descriptor))
				assert.Equal(t, tc.status, recorder.Code)
				assert.Equal(t, "video/mp4", recorder.Header().Get("Content-Type"))
				assert.Equal(t, string(tc.body), recorder.Body.String())
			})
		}
	}
	assert.Equal(t, 6, calls)
}

func TestIndependentPluginCatalogueGrokVideoExternalContentHasNoKey(t *testing.T) {
	task := setupGenericTaskTest(t)
	allowPrivateTaskMediaTest(t)
	calls := 0
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		assert.Empty(t, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write([]byte("external-video"))
	}))
	defer external.Close()
	source, err := os.ReadFile("../../plugins/grok-video/plugin.js")
	require.NoError(t, err)
	plugin, err := pluginruntime.NewRegistry().Register(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	adaptor := taskjsplugin.New(plugin)
	adaptor.Init(&relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{
		ChannelType: constant.ChannelTypeTaskPlugin, ChannelBaseUrl: "https://sub.example.invalid", ApiKey: "fixture-secret",
	}})
	task.Data, err = common.Marshal(map[string]any{"status": "done", "video": map[string]any{"url": external.URL + "/video.mp4"}})
	require.NoError(t, err)
	descriptor, err := adaptor.BuildContentRequest(task, "video", relaychannel.TaskArtifactClientRequest{Method: http.MethodGet})
	require.NoError(t, err)
	assert.True(t, descriptor.Credentialless)
	assert.Empty(t, descriptor.Headers)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/task_generic/artifacts/video/content", nil)
	require.NoError(t, proxyTaskMedia(c, task, descriptor))
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, "external-video", recorder.Body.String())
	assert.Equal(t, 1, calls)

	// Authenticated cross-origin redirects must be rejected by the host rather
	// than forwarding the Sub2API credential to the destination.
	protected := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer fixture-secret", r.Header.Get("Authorization"))
		http.Redirect(w, r, external.URL+"/video.mp4", http.StatusFound)
	}))
	defer protected.Close()
	adaptor.Init(&relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{
		ChannelType: constant.ChannelTypeTaskPlugin, ChannelBaseUrl: protected.URL, ApiKey: "fixture-secret",
	}})
	task.Data, err = common.Marshal(map[string]any{"status": "done", "video": map[string]any{"url": "/redirect"}})
	require.NoError(t, err)
	descriptor, err = adaptor.BuildContentRequest(task, "video", relaychannel.TaskArtifactClientRequest{Method: http.MethodGet})
	require.NoError(t, err)
	assert.False(t, descriptor.Credentialless)
	recorder = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodGet, "/v1/tasks/task_generic/artifacts/video/content", nil)
	var proxyErr *taskMediaProxyError
	require.ErrorAs(t, proxyTaskMedia(c, task, descriptor), &proxyErr)
	assert.Equal(t, "artifact_request_rejected", proxyErr.code)
	assert.Equal(t, 1, calls, "authenticated redirect must not reach the external destination")
}

// The model square shows a "price examples" table whenever the pricing API
// carries plugin usage examples; Grok publishes none, only the per-resolution
// schema that drives the compact matrix.
func TestIndependentPluginCatalogueGrokVideoNoPriceExamples(t *testing.T) {
	source, err := os.ReadFile("../../plugins/grok-video/plugin.js")
	require.NoError(t, err)
	plugin, err := pluginruntime.NewRegistry().Register(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	for name, expected := range map[string][]string{
		"grok-imagine-video":     {"480p", "720p"},
		"grok-imagine-video-1.5": {"480p", "720p", "1080p"},
		"grok-imagine-video-2":   {"480p", "720p", "1080p"},
	} {
		schema, examples := plugin.Meta.UsageForModel(name)
		assert.Empty(t, examples, name)
		assert.Equal(t, expected, schema["resolution"].Enum, name)
		assert.Contains(t, schema, "seconds", name)
	}
}

// The signed xAI URL is reported as the task result so the host can hand it to
// the transfer Worker, while customer content still goes through Sub2API.
func TestIndependentPluginCatalogueGrokVideoSignedSourceResult(t *testing.T) {
	task := setupGenericTaskTest(t)
	source, err := os.ReadFile("../../plugins/grok-video/plugin.js")
	require.NoError(t, err)
	plugin, err := pluginruntime.NewRegistry().Register(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	adaptor := taskjsplugin.New(plugin)
	adaptor.Init(&relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{
		ChannelType: constant.ChannelTypeTaskPlugin, ChannelBaseUrl: "http://sub2api:8080", ApiKey: "fixture-secret",
	}})
	const signed = "https://vidgen.x.ai/xai-vidgen-bucket/xai-video-fixture.mp4"
	const proxied = "http://sub2api:8080/v1/videos/upstream/content"
	for _, tc := range []struct{ source, want string }{
		{signed, signed},
		{"https://vidgen.x.ai.evil.invalid/xai-video-fixture.mp4", proxied},
		{"https://user@vidgen.x.ai/xai-video-fixture.mp4", proxied},
		{"", proxied},
	} {
		payload, err := common.Marshal(map[string]any{"status": "done", "video": map[string]any{
			"url": "/v1/videos/upstream/content", "source_url": tc.source,
		}})
		require.NoError(t, err)
		result, err := adaptor.ParseTaskResult(task, &http.Response{StatusCode: http.StatusOK, Header: http.Header{}}, payload)
		require.NoError(t, err)
		assert.Equal(t, "SUCCESS", result.Status, tc.source)
		assert.Equal(t, tc.want, result.Url, tc.source)

		task.Data = payload
		descriptor, err := adaptor.BuildContentRequest(task, "video", relaychannel.TaskArtifactClientRequest{Method: http.MethodGet})
		require.NoError(t, err)
		assert.Equal(t, proxied, descriptor.URL)
		assert.False(t, descriptor.Credentialless)
		assert.Equal(t, "Bearer fixture-secret", descriptor.Headers["Authorization"])
	}
}
