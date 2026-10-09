package jsplugin

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	for _, name := range []string{"veo-3.1", "veo-3.1-fast", "gemini-omni-flash", "gemini-omni-flash-1.1", "gemini-omni-1.1-flash-preview",
		"gemini-omni-flash-preview", "veo-3.1-generate-001", "veo-3.1-fast-generate-001"} {
		_, ok = generation.LookupEndpoint("POST", "/v1/videos", name)
		assert.False(t, ok)
	}
	for _, name := range []string{"vertex-omni-1.1-test", "vertex-omni-flash-test", "vertex-veo-3.1-test", "vertex-veo-3.1-fast-test"} {
		endpoint, ok := generation.LookupEndpoint("POST", "/v1/videos", name)
		require.True(t, ok, name)
		assert.Same(t, plugin, endpoint.Plugin, name)
	}

	originalAuth := acquireAccessToken
	pluginAuthCache = sync.Map{}
	acquireAccessToken = func(credentials vertexcore.Credentials, _ string) (string, error) {
		assert.Equal(t, "fixture-project", credentials.ProjectID)
		return "fixture-oauth", nil
	}
	t.Cleanup(func() { acquireAccessToken = originalAuth; pluginAuthCache = sync.Map{} })
	key, err := common.Marshal(vertexcore.Credentials{ProjectID: "fixture-project", PrivateKey: "fixture-not-a-key"})
	require.NoError(t, err)
	// 1.3.0 always requests URI delivery: no video bytes reach NewAPI memory.
	stored := "gs://88api-omni-media/vertex-omni/task_publicfixture/fixture.mp4"
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
			assert.Equal(t, "uri", format["delivery"])
			assert.Equal(t, "gs://88api-omni-media/vertex-omni/task_publicfixture/", format["gcs_uri"])
			_, err = io.WriteString(w, `{"id":"v1_fixture","status":"in_progress"}`)
			require.NoError(t, err)
		case http.MethodGet:
			polls++
			assert.Equal(t, "/v1beta1/projects/fixture-project/locations/global/interactions/v1_fixture", r.URL.Path)
			body := `{"id":"v1_fixture","status":"in_progress"}`
			if polls > 1 {
				body = `{"id":"v1_fixture","status":"completed","outputs":[{"type":"model_output","content":[{"type":"video","mime_type":"video/mp4","uri":"` + stored + `"}]}],"usage":{"total_output_tokens":28832}}`
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
		TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_publicfixture"},
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

	task := &model.Task{TaskID: "task_publicfixture",
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
			assert.Equal(t, "https://storage.googleapis.com/storage/v1/b/88api-omni-media/o/"+
				url.PathEscape("vertex-omni/task_publicfixture/fixture.mp4")+"?alt=media", result.Url)
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

	// Inputs are Data URI JSON only; multipart file uploads are refused.
	_, err = plugin.Engine.CallPath(context.Background(), "protocols", []string{"openai_video", "decodeRequest"},
		map[string]any{"model": info.OriginModelName, "body": map[string]any{
			"kind": "multipart", "fields": map[string]any{"prompt": []any{"Edit fixture"}},
			"files": []any{map[string]any{"ref": "request_file:video", "field": "video", "size": 13, "mimeType": "video/mp4"}},
		}})
	require.Error(t, err)

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
		expected := resolution
		if resolution == "360p" {
			expected = "720p" // 360p is not sold: generated and billed as 720p
		}
		assert.Equal(t, expected, format["resolution"])
		assert.Equal(t, "10s", format["duration"])
		generation := wire["generation_config"].(map[string]any)
		assert.EqualValues(t, 0, generation["temperature"])
		assert.EqualValues(t, 1, generation["top_p"])
		assert.Equal(t, expected, call("extractUsage", c).(map[string]any)["resolution"])
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
	c := ctx(map[string]any{"prompt": "Extend fixture", "task": "extend", "video": "https://cdn.example.com/clip.mp4"})
	preflight := call("buildPreflightRequest", c).(map[string]any)
	assert.Equal(t, "https://assets.88api.ai/gcs/ingest", preflight["url"])
	assert.NotContains(t, preflight["headers"], "Authorization")
	assert.Equal(t, true, preflight["body"].(map[string]any)["measure"])
	// The host stores the Worker's ingest answer and passes it to every submit hook.
	c["preflightResponse"] = map[string]any{"status": 200, "body": map[string]any{"object": "gcs_ingest", "items": []any{
		map[string]any{"url": "https://cdn.example.com/clip.mp4", "kind": "video", "mime_type": "video/mp4",
			"uri": "gs://88api-omni-media/vertex-omni-inputs/2026-10-09/in.mp4", "facts": map[string]any{"seconds": 3, "resolution": "720p"}},
	}}}
	wire := call("buildSubmitRequest", c).(map[string]any)["body"].(map[string]any)
	input := wire["input"].([]any)[0].(map[string]any)["content"].([]any)[0].(map[string]any)
	assert.Equal(t, "gs://88api-omni-media/vertex-omni-inputs/2026-10-09/in.mp4", input["uri"])
	format := wire["response_format"].([]any)[0].(map[string]any)
	assert.Equal(t, map[string]any{"type": "video", "delivery": "uri",
		"gcs_uri": "gs://88api-omni-media/vertex-omni/unassigned/"}, format)
	assert.EqualValues(t, 11, call("extractUsage", c).(map[string]any)["seconds"], "reserve one ~10s segment")
	response := map[string]any{"body": map[string]any{"id": "v1_extension", "status": "in_progress"}}
	submitted := call("parseSubmitResponse", c, response).(map[string]any)
	state := submitted["state"].(map[string]any)
	assert.Equal(t, true, state["bill_added_seconds"])
	assert.EqualValues(t, 3, state["input_seconds"])
	query := map[string]any{"taskId": "v1_extension", "action": "extend", "state": state}

	// URI delivery: wait for a header-only Worker probe, then settle added seconds.
	stored := "gs://88api-omni-media/vertex-omni/unassigned/out.mp4"
	delivered := map[string]any{"id": "v1_extension", "status": "completed", "outputs": []any{
		map[string]any{"type": "video", "mime_type": "video/mp4", "uri": stored}}}
	waiting := call("parseTaskResult", query, delivered).(map[string]any)
	assert.Equal(t, "IN_PROGRESS", waiting["status"])
	probing := map[string]any{"taskId": "v1_extension", "action": "extend", "state": waiting["state"]}
	probeRequest := call("buildQueryRequest", probing).(map[string]any)
	assert.Equal(t, "https://assets.88api.ai/gcs/probe?id=v1_extension&uri="+url.QueryEscape(stored), probeRequest["url"])
	assert.NotContains(t, probeRequest["headers"], "Authorization")
	probe := map[string]any{"object": "gcs_probe", "id": "v1_extension", "status": "completed",
		"outputs": []any{map[string]any{"type": "video", "mime_type": "video/mp4", "uri": stored}},
		"facts":   map[string]any{"seconds": 13.032, "resolution": "720p"}}
	probed := call("parseTaskResult", probing, probe).(map[string]any)
	assert.Equal(t, "SUCCESS", probed["status"])
	assert.InDelta(t, 10.032, call("extractUsageOnComplete", probing, probed, probe).(map[string]any)["seconds"], 1e-9,
		"charge output minus input, not the full movie or the reserve")

	// Inline output (legacy delivery) settles the same added-seconds contract.
	data := map[string]any{"id": "v1_extension", "status": "completed", "outputs": []any{
		map[string]any{"type": "video", "mime_type": "video/mp4", "data": mp4(9)},
	}, "usage": map[string]any{"total_output_tokens": 99999}, "duration": 100}
	result := call("parseTaskResult", query, data).(map[string]any)
	assert.Equal(t, "SUCCESS", result["status"])
	facts := call("extractUsageOnComplete", query, result, data).(map[string]any)
	assert.EqualValues(t, 6, facts["seconds"], "charge 6s added, not 9s output or 11s reserve")
	immediate := call("parseSubmitResponse", c, map[string]any{"body": data}).(map[string]any)
	immediateFacts := call("extractUsageOnComplete", map[string]any{"action": "extend", "state": immediate["state"]},
		immediate["immediate"], immediate["taskData"]).(map[string]any)
	assert.EqualValues(t, 6, immediateFacts["seconds"])
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

// Veo runs through the same shipped plugin in Sobek: regional
// predictLongRunning with storageUri, fetchPredictOperation polling and a
// gcsUri result. Local provider and stub OAuth only.
func TestIndependentPluginCatalogueVertexVeoHTTP(t *testing.T) {
	source, err := os.ReadFile("../../../../../plugins/vertex-omni/plugin.js")
	require.NoError(t, err)
	plugin, err := pluginruntime.NewRegistry().Register(string(source), pluginruntime.Options{})
	require.NoError(t, err)
	originalAuth := acquireAccessToken
	pluginAuthCache = sync.Map{}
	acquireAccessToken = func(vertexcore.Credentials, string) (string, error) { return "fixture-oauth", nil }
	t.Cleanup(func() { acquireAccessToken = originalAuth; pluginAuthCache = sync.Map{} })
	key, err := common.Marshal(vertexcore.Credentials{ProjectID: "fixture-project", PrivateKey: "fixture-not-a-key"})
	require.NoError(t, err)
	operation := "projects/fixture-project/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/0b6c5f3a-1111-4222-8333-944455556666"
	stored := "gs://88api-omni-media/vertex-omni/task_publicveofixture/1208296686290258483/sample_0.mp4"
	polls, submits := 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer fixture-oauth", r.Header.Get("Authorization"))
		assert.Equal(t, http.MethodPost, r.Method)
		w.Header().Set("Content-Type", "application/json")
		var body map[string]any
		require.NoError(t, common.DecodeJson(r.Body, &body))
		prefix := "/v1/projects/fixture-project/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001:"
		switch r.URL.Path {
		case prefix + "predictLongRunning":
			submits++
			parameters := body["parameters"].(map[string]any)
			assert.Equal(t, "gs://88api-omni-media/vertex-omni/task_publicveofixture/", parameters["storageUri"])
			assert.EqualValues(t, 6, parameters["durationSeconds"])
			assert.Equal(t, "4k", parameters["resolution"])
			assert.Equal(t, false, parameters["generateAudio"])
			_, err = io.WriteString(w, `{"name":"`+operation+`"}`)
			require.NoError(t, err)
		case prefix + "fetchPredictOperation":
			polls++
			assert.Equal(t, operation, body["operationName"])
			reply := `{"name":"` + operation + `"}`
			if polls > 1 {
				reply = `{"name":"` + operation + `","done":true,"response":{"raiMediaFilteredCount":0,"videos":[{"gcsUri":"` + stored + `","mimeType":"video/mp4"}]}}`
			}
			_, err = io.WriteString(w, reply)
			require.NoError(t, err)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	info := &relaycommon.RelayInfo{
		OriginModelName: "vertex-veo-3.1-fast-test",
		ChannelMeta: &relaycommon.ChannelMeta{ChannelType: constant.ChannelTypeTaskPlugin,
			ChannelBaseUrl: server.URL, ApiKey: string(key), UpstreamModelName: "veo-3.1-fast-generate-001"},
		TaskRelayInfo: &relaycommon.TaskRelayInfo{PublicTaskID: "task_publicveofixture"},
	}
	adaptor := New(plugin)
	adaptor.Init(info)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/videos", strings.NewReader(`{}`))
	c.Set("task_request", map[string]any{"prompt": "Fixture", "duration": 6, "size": "3840x2160", "generate_audio": false})
	require.Nil(t, adaptor.ValidateRequestAndSetAction(c, info))
	facts, err := adaptor.ExtractUsageFactsValidated(c, info)
	require.NoError(t, err)
	assert.EqualValues(t, 6, facts["seconds"])
	assert.Equal(t, "4k", facts["resolution"])
	assert.Equal(t, false, facts["generate_audio"])
	body, err := adaptor.BuildRequestBody(c, info)
	require.NoError(t, err)
	resp, err := adaptor.DoRequest(c, info, body)
	require.NoError(t, err)
	defer resp.Body.Close()
	accepted, taskErr := adaptor.ParseResponse(c, resp, info)
	require.Nil(t, taskErr)
	require.NotNil(t, accepted)
	assert.NotContains(t, accepted.UpstreamTaskID, "/", "operation names are encoded into a safe task ID")
	task := &model.Task{TaskID: "task_publicveofixture",
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
		if expected == "SUCCESS" {
			assert.Equal(t, "https://storage.googleapis.com/storage/v1/b/88api-omni-media/o/"+
				url.PathEscape("vertex-omni/task_publicveofixture/1208296686290258483/sample_0.mp4")+"?alt=media", result.Url)
		}
	}
	assert.Equal(t, 1, submits, "polling must never start a new billable operation")
	assert.Equal(t, 2, polls)
}
