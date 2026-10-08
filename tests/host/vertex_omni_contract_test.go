package jsplugin

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	pluginruntime "github.com/QuantumNous/new-api/pkg/jsplugin"
	"github.com/QuantumNous/new-api/relay/channel"
	vertexcore "github.com/QuantumNous/new-api/relay/channel/vertex"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// This regression uses the shipped independent plugin in Sobek and the real
// HTTP adaptor, with a local provider and stub OAuth. No production/API calls.
func TestIndependentPluginCatalogueVertexOmniHTTP(t *testing.T) {
	source, err := os.ReadFile("../../../../../plugins/vertex-omni/plugin.js")
	require.NoError(t, err)
	registry := pluginruntime.NewRegistry()
	factorySource, err := os.ReadFile("../../../../plugins/tasks/vertex-ai/plugin.js")
	require.NoError(t, err)
	factory, err := registry.Register(string(factorySource), pluginruntime.Options{})
	require.NoError(t, err)
	plugin, err := registry.Register(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	generation := registry.Generation()
	legacy, ok := generation.GetByChannelType(41)
	require.True(t, ok)
	assert.Same(t, factory, legacy, "independent upload must not replace Vertex/Veo")
	for _, name := range factory.Meta.Models {
		endpoint, ok := generation.LookupEndpoint("POST", "/v1/videos", name)
		require.True(t, ok)
		assert.Same(t, factory, endpoint.Plugin)
	}
	for _, name := range []string{"veo-3.1", "gemini-omni-flash", "gemini-omni-flash-1.1", "gemini-omni-1.1-flash-preview"} {
		_, ok = generation.LookupEndpoint("POST", "/v1/videos", name)
		assert.False(t, ok)
	}
	_, ok = generation.LookupEndpoint("POST", "/v1/videos", "vertex-omni-1.1-test")
	require.True(t, ok)

	originalAuth := acquireAccessToken
	pluginAuthCache = sync.Map{}
	acquireAccessToken = func(credentials vertexcore.Credentials, _ string) (string, error) {
		assert.Equal(t, "fixture-project", credentials.ProjectID)
		return "fixture-oauth", nil
	}
	t.Cleanup(func() { acquireAccessToken = originalAuth; pluginAuthCache = sync.Map{} })
	key, err := common.Marshal(vertexcore.Credentials{ProjectID: "fixture-project", PrivateKey: "fixture-not-a-key"})
	require.NoError(t, err)
	// >1MiB inline output proves polling does not hit the JSON submission cap.
	videoBytes := bytes.Repeat([]byte("fixture-mp4"), 110000)
	encoded := base64.StdEncoding.EncodeToString(videoBytes)
	polls, submits := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer fixture-oauth", r.Header.Get("Authorization"))
		assert.Equal(t, "fixture-project", r.Header.Get("x-goog-user-project"))
		assert.Empty(t, r.Header.Get("Api-Revision"))
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodPost:
			submits++
			assert.Equal(t, "/v1beta1/projects/fixture-project/locations/global/interactions", r.URL.Path)
			var body map[string]any
			require.NoError(t, common.DecodeJson(r.Body, &body))
			assert.Equal(t, "gemini-omni-1.1-flash-preview", body["model"])
			assert.Equal(t, true, body["background"])
			format := body["response_format"].([]any)[0].(map[string]any)
			assert.Equal(t, "4", format["duration"])
			assert.Equal(t, "9:16", format["aspect_ratio"])
			_, err = io.WriteString(w, `{"id":"v1_fixture","status":"in_progress"}`)
			require.NoError(t, err)
		case http.MethodGet:
			polls++
			assert.Equal(t, "/v1beta1/projects/fixture-project/locations/global/interactions/v1_fixture", r.URL.Path)
			body := `{"id":"v1_fixture","status":"in_progress"}`
			if polls > 1 {
				body = `{"id":"v1_fixture","status":"completed","outputs":[{"type":"model_output","content":[{"type":"video","mime_type":"video/mp4","data":"` + encoded + `"}]}],"usage":{"total_output_tokens":28832}}`
			}
			_, err = io.WriteString(w, body)
			require.NoError(t, err)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	info := &relaycommon.RelayInfo{
		OriginModelName: "vertex-omni-1.1-test",
		ChannelMeta: &relaycommon.ChannelMeta{ChannelType: constant.ChannelTypeTaskPlugin,
			ChannelBaseUrl: server.URL, ApiKey: string(key), UpstreamModelName: "gemini-omni-1.1-flash-preview"},
		TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_public"},
	}
	adaptor := New(plugin)
	adaptor.Init(info)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/videos", strings.NewReader(`{}`))
	c.Set("task_request", map[string]any{"prompt": "Fixture", "duration": 4, "size": "720x1280"})
	require.Nil(t, adaptor.ValidateRequestAndSetAction(c, info))
	facts, err := adaptor.ExtractUsageFactsValidated(c, info)
	require.NoError(t, err)
	assert.EqualValues(t, 4, facts["seconds"])
	assert.Equal(t, "720p", facts["resolution"])
	body, err := adaptor.BuildRequestBody(c, info)
	require.NoError(t, err)
	resp, err := adaptor.DoRequest(c, info, body)
	require.NoError(t, err)
	defer resp.Body.Close()
	accepted, taskErr := adaptor.ParseResponse(c, resp, info)
	require.Nil(t, taskErr)
	require.NotNil(t, accepted)
	assert.Equal(t, "v1_fixture", accepted.UpstreamTaskID)
	assert.NotContains(t, string(accepted.TaskData), "fixture-oauth")

	task := &model.Task{TaskID: "task_public",
		Properties:  model.Properties{OriginModelName: info.OriginModelName, UpstreamModelName: info.UpstreamModelName},
		PrivateData: model.TaskPrivateData{UpstreamTaskID: accepted.UpstreamTaskID, PluginState: accepted.PluginState}}
	for _, expected := range []string{"IN_PROGRESS", "SUCCESS"} {
		query, err := adaptor.FetchTask(server.URL, string(key), task, "")
		require.NoError(t, err)
		payload, err := io.ReadAll(query.Body)
		require.NoError(t, err)
		require.NoError(t, query.Body.Close())
		result, err := adaptor.ParseTaskResult(task, query, payload)
		require.NoError(t, err)
		assert.Equal(t, expected, result.Status)
		assert.Empty(t, result.UsageFacts, "token counts must not alter requested seconds")
		if expected == "SUCCESS" {
			assert.Equal(t, "data:video/mp4;base64,"+encoded, result.Url)
			assert.Equal(t, "100%", result.Progress)
		} else {
			assert.NotEqual(t, "100%", result.Progress)
		}
	}
	assert.Equal(t, 1, submits, "polling must never start a new billable interaction")
	assert.Equal(t, 2, polls)

	// Exercise protected GCS content through the host URL/credential checks.
	task.Status = model.TaskStatusSuccess
	task.Data = []byte(`{"id":"v1_fixture","status":"completed","outputs":[{"type":"video","mime_type":"video/mp4","uri":"gs://fixture-bucket/out/fixture.mp4"}]}`)
	artifacts, err := adaptor.ListArtifacts(task)
	require.NoError(t, err)
	require.Len(t, artifacts, 1)
	assert.Equal(t, "video", artifacts[0].Key)
	content, err := adaptor.BuildContentRequest(task, "video", channel.TaskArtifactClientRequest{Method: http.MethodHead})
	require.NoError(t, err)
	assert.Equal(t, "https://storage.googleapis.com/storage/v1/b/fixture-bucket/o/out%2Ffixture.mp4?alt=media", content.URL)
	assert.Equal(t, "Bearer fixture-oauth", content.Headers["Authorization"])
	assert.False(t, content.Credentialless)
	task.Data = []byte(`{"status":"completed","outputs":[{"type":"video","uri":"https://cdn.example.invalid/out.mp4?signature=fixture"}]}`)
	content, err = adaptor.BuildContentRequest(task, "video", channel.TaskArtifactClientRequest{Method: http.MethodGet})
	require.NoError(t, err)
	assert.True(t, content.Credentialless)
	assert.Empty(t, content.Headers)

	// Real multipart placeholders are expanded by the host, not JS file I/O.
	fileContext := newMultipartFileContext(t, "video", "fixture.mp4", "video/mp4", []byte("fixture-video"))
	decoded, err := plugin.Engine.CallPath(context.Background(), "protocols", []string{"openai_video", "decodeRequest"},
		map[string]any{"model": info.OriginModelName, "body": map[string]any{
			"kind": "multipart", "fields": map[string]any{"prompt": []any{"Edit fixture"}, "duration": []any{"4"}},
			"files": []any{map[string]any{"ref": "request_file:video", "field": "video", "size": 13, "mimeType": "video/mp4"}},
		}})
	require.NoError(t, err)
	fileContext.Set("task_request", decoded.(map[string]any)["requestBody"])
	fileAdaptor := New(plugin)
	fileAdaptor.Init(info)
	require.Nil(t, fileAdaptor.ValidateRequestAndSetAction(fileContext, info))
	fileBody, err := fileAdaptor.BuildRequestBody(fileContext, info)
	require.NoError(t, err)
	var wire map[string]any
	require.NoError(t, common.DecodeJson(fileBody, &wire))
	parts := wire["input"].([]any)[0].(map[string]any)["content"].([]any)
	assert.Equal(t, base64.StdEncoding.EncodeToString([]byte("fixture-video")), parts[0].(map[string]any)["data"])

	for _, invalid := range []map[string]any{
		{"prompt": "Fixture", "duration": 11}, {"prompt": "Fixture", "duration": 3, "seconds": 4},
		{"prompt": "Fixture", "metadata": map[string]any{"sampleCount": 3}},
	} {
		_, err := plugin.Engine.Call(context.Background(), "extractUsage",
			map[string]any{"model": info.OriginModelName, "requestBody": invalid})
		require.Error(t, err)
	}
}
