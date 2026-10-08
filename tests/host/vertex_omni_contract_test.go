package jsplugin

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
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
			// Google REST duration is a seconds-qualified string, not "4".
			if format["duration"] != "4s" {
				w.WriteHeader(http.StatusBadRequest)
				_, err = io.WriteString(w, `{"error":{"message":"Invalid input at 'response_format[0]'.","code":"invalid_request"}}`)
				require.NoError(t, err)
				return
			}
			assert.Equal(t, "4s", format["duration"])
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

func TestIndependentPluginCatalogueVertexOmniCapabilitiesAndExtensionUsage(t *testing.T) {
	source, err := os.ReadFile("../../../../../plugins/vertex-omni/plugin.js")
	require.NoError(t, err)
	plugin, err := pluginruntime.NewRegistry().Register(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	call := func(hook string, args ...any) any {
		value, callErr := plugin.Engine.Call(context.Background(), hook, args...)
		require.NoError(t, callErr, hook)
		return value
	}
	ctx := func(body map[string]any) map[string]any {
		return map[string]any{"model": "vertex-omni-1.1-test", "requestBody": body,
			"upstreamModel": "gemini-omni-1.1-flash-preview", "baseUrl": "https://aiplatform.googleapis.com",
			"authHeader": "Bearer fixture", "auth": map[string]any{"projectId": "fixture-project"}}
	}
	for _, resolution := range []string{"360p", "720p", "1080p", "4k"} {
		c := ctx(map[string]any{"prompt": "Fixture", "duration": 10, "resolution": resolution,
			"aspect_ratio": "9:16", "temperature": 0, "top_p": 1})
		wire := call("buildSubmitRequest", c).(map[string]any)["body"].(map[string]any)
		format := wire["response_format"].([]any)[0].(map[string]any)
		assert.Equal(t, resolution, format["resolution"])
		assert.Equal(t, "10s", format["duration"])
		generation := wire["generation_config"].(map[string]any)
		assert.EqualValues(t, 0, generation["temperature"])
		assert.EqualValues(t, 1, generation["top_p"])
		assert.Equal(t, resolution, call("extractUsage", c).(map[string]any)["resolution"])
	}
	atom := func(kind string, body []byte) []byte {
		header := make([]byte, 8)
		binary.BigEndian.PutUint32(header, uint32(len(body)+8))
		copy(header[4:], kind)
		return append(header, body...)
	}
	mp4 := func(seconds uint32) string {
		mdhd, hdlr, tkhd := make([]byte, 24), make([]byte, 24), make([]byte, 84)
		binary.BigEndian.PutUint32(mdhd[12:], 1000)
		binary.BigEndian.PutUint32(mdhd[16:], seconds*1000)
		copy(hdlr[8:], "vide")
		binary.BigEndian.PutUint32(tkhd[76:], 1280*65536)
		binary.BigEndian.PutUint32(tkhd[80:], 720*65536)
		mdia := atom("mdia", append(atom("mdhd", mdhd), atom("hdlr", hdlr)...))
		trak := atom("trak", append(atom("tkhd", tkhd), mdia...))
		data := append(atom("ftyp", []byte("isom0000")), atom("moov", append(atom("mvhd", mdhd), trak...))...)
		return base64.StdEncoding.EncodeToString(data)
	}
	c := ctx(map[string]any{"prompt": "Extend fixture", "task": "extend", "duration": 6,
		"video": "data:video/mp4;base64," + mp4(3)})
	wire := call("buildSubmitRequest", c).(map[string]any)["body"].(map[string]any)
	format := wire["response_format"].([]any)[0].(map[string]any)
	assert.Equal(t, map[string]any{"type": "video"}, format)
	assert.EqualValues(t, 6, call("extractUsage", c).(map[string]any)["seconds"])
	response := map[string]any{"body": map[string]any{"id": "v1_extension", "status": "in_progress"}}
	submitted := call("parseSubmitResponse", c, response).(map[string]any)
	query := map[string]any{"taskId": "v1_extension", "action": "extend", "state": submitted["state"]}
	data := map[string]any{"id": "v1_extension", "status": "completed", "outputs": []any{
		map[string]any{"type": "video", "mime_type": "video/mp4", "data": mp4(9)},
	}, "usage": map[string]any{"total_output_tokens": 99999}, "duration": 100}
	result := call("parseTaskResult", query, data).(map[string]any)
	assert.Equal(t, "SUCCESS", result["status"])
	facts := call("extractUsageOnComplete", query, result, data).(map[string]any)
	assert.EqualValues(t, 9, facts["seconds"], "charge full 9s output, not 6s requested or 6s added")
	immediate := call("parseSubmitResponse", c, map[string]any{"body": data}).(map[string]any)
	immediateFacts := call("extractUsageOnComplete", map[string]any{"action": "extend", "state": immediate["state"]},
		immediate["immediate"], immediate["taskData"]).(map[string]any)
	assert.EqualValues(t, 9, immediateFacts["seconds"])
	assert.NotContains(t, string(mustMarshalOmniTest(t, immediate["taskData"])), mp4(9))

	// New continuations use output facts, while pre-upgrade snapshots retain
	// their old contract. Nothing rewrites already billed production tasks.
	multi := ctx(map[string]any{"prompt": "Continue fixture", "duration": 3,
		"previous_interaction_id": "v1_previous"})
	multiWire := call("buildSubmitRequest", multi).(map[string]any)["body"].(map[string]any)
	assert.NotContains(t, multiWire, "generation_config")
	assert.Equal(t, "3s", multiWire["response_format"].([]any)[0].(map[string]any)["duration"])
	assert.EqualValues(t, 40, call("extractUsage", multi).(map[string]any)["seconds"])
	multiSubmitted := call("parseSubmitResponse", multi, response).(map[string]any)
	multiState := multiSubmitted["state"].(map[string]any)
	assert.Equal(t, true, multiState["bill_output_duration"])
	assert.EqualValues(t, 3, multiState["requested_seconds"])
	multiQuery := map[string]any{"taskId": "v1_extension", "action": "text_to_video", "state": multiState}
	multiResult := call("parseTaskResult", multiQuery, data).(map[string]any)
	assert.Equal(t, "SUCCESS", multiResult["status"])
	assert.EqualValues(t, 9, call("extractUsageOnComplete", multiQuery, multiResult, data).(map[string]any)["seconds"])
	assert.Nil(t, call("extractUsageOnComplete", map[string]any{"action": "text_to_video",
		"state": map[string]any{"seconds": 3}}, multiResult, data))
}

func mustMarshalOmniTest(t *testing.T, value any) []byte {
	t.Helper()
	data, err := common.Marshal(value)
	require.NoError(t, err)
	return data
}
