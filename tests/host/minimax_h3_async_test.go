package jsplugin

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Real Sobek hooks exchange requests/responses with an isolated HTTP upstream.
// No production key, model request, database or billable generation is used.
func TestIndependentPluginCatalogueH3AsyncHTTP(t *testing.T) {
	source, err := os.ReadFile("../../../plugins/minimax-h3-async/plugin.js")
	require.NoError(t, err)
	plugin, err := NewRegistry().Register(string(source), Options{})
	require.NoError(t, err)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		assert.Equal(t, "Bearer fixture", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/api/generate":
			assert.Equal(t, "POST", r.Method)
			var body map[string]any
			require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
			assert.Equal(t, "minimax-h3", body["model"])
			assert.Equal(t, "async", body["replyType"])
			assert.Equal(t, "portrait", body["aspectRatio"])
			assert.Equal(t, "768p", body["resolution"])
			assert.EqualValues(t, 5, body["duration"])
			assert.EqualValues(t, 0, body["seed"])
			_, _ = io.WriteString(w, `{"id":"upstream-id","status":"running"}`)
		case "/v1/api/result":
			assert.Equal(t, "GET", r.Method)
			assert.Equal(t, "upstream-id", r.URL.Query().Get("id"))
			_, _ = io.WriteString(w, `{"id":"upstream-id","status":"succeeded","results":[{"url":"https://example.invalid/video.mp4"}]}`)
		default:
			t.Errorf("unexpected upstream path: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	call := func(hook string, args ...any) any {
		t.Helper()
		out, err := plugin.Engine.Call(context.Background(), hook, args...)
		require.NoError(t, err)
		return out
	}
	send := func(descriptor map[string]any) map[string]any {
		t.Helper()
		body := ""
		if descriptor["body"] != nil {
			raw, err := json.Marshal(descriptor["body"])
			require.NoError(t, err)
			body = string(raw)
		}
		req, err := http.NewRequest(descriptor["method"].(string), descriptor["url"].(string), strings.NewReader(body))
		require.NoError(t, err)
		for name, value := range descriptor["headers"].(map[string]any) {
			req.Header.Set(name, value.(string))
		}
		response, err := server.Client().Do(req)
		require.NoError(t, err)
		defer response.Body.Close()
		require.Equal(t, 200, response.StatusCode)
		var value map[string]any
		require.NoError(t, json.NewDecoder(response.Body).Decode(&value))
		return value
	}
	decoded, err := plugin.Engine.CallPath(context.Background(), "protocols",
		[]string{"openai_video", "decodeRequest"}, map[string]any{
			"model": "minimax-h3-768p", "body": map[string]any{"kind": "json", "value": map[string]any{
				"prompt": "Fixture", "seconds": "5", "ratio": "9:16", "seed": 0,
			}},
		})
	require.NoError(t, err)
	ctx := map[string]any{"model": "minimax-h3-768p", "upstreamModel": "minimax-h3",
		"baseUrl": server.URL, "apiKey": "fixture", "requestBody": decoded.(map[string]any)["requestBody"]}
	usage := call("extractUsage", ctx).(map[string]any)
	assert.EqualValues(t, 5, usage["seconds"])
	submit := call("buildSubmitRequest", ctx).(map[string]any)
	accepted := call("parseSubmitResponse", ctx, map[string]any{"body": send(submit)}).(map[string]any)
	assert.Equal(t, "upstream-id", accepted["taskId"])
	queryCtx := map[string]any{"taskId": accepted["taskId"], "baseUrl": server.URL, "apiKey": "fixture"}
	query := call("buildQueryRequest", queryCtx).(map[string]any)
	body := send(query)
	result := call("parseTaskResult", queryCtx, body).(map[string]any)
	assert.Equal(t, "SUCCESS", result["status"])
	assert.Equal(t, "100%", result["progress"])
	assert.Nil(t, call("extractUsageOnComplete", queryCtx, result, body))
	artifacts := call("listArtifacts", map[string]any{"status": "SUCCESS", "data": body}).([]any)
	require.Len(t, artifacts, 1)
	content := call("buildContentRequest", map[string]any{"artifactKey": "video", "data": body,
		"clientRequest": map[string]any{"method": "GET"}}).(map[string]any)
	assert.Equal(t, true, content["credentialless"])
	assert.Equal(t, "https://example.invalid/video.mp4", content["url"])
	assert.Nil(t, content["headers"])
	assert.Equal(t, 2, calls)
	for _, tc := range []map[string]any{
		{"prompt": "Fixture", "duration": 0},
		{"prompt": "Fixture", "duration": 16},
		{"prompt": "Fixture", "duration": 5, "resolution": "1080p"},
		{"prompt": "Fixture", "duration": true},
	} {
		ctx["requestBody"] = tc
		_, err := plugin.Engine.Call(context.Background(), "extractUsage", ctx)
		assert.Error(t, err)
	}
}
