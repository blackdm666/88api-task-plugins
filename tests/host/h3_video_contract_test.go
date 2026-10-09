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
func TestIndependentPluginCatalogueH3VideoHTTP(t *testing.T) {
	source, err := os.ReadFile("../../../plugins/h3-video/plugin.js")
	require.NoError(t, err)
	plugin, err := NewRegistry().Register(string(source), Options{})
	require.NoError(t, err)
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer fixture", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/videos":
			assert.Equal(t, "POST", r.Method)
			assert.Equal(t, "task_public01", r.Header.Get("Idempotency-Key"))
			var body map[string]any
			require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
			assert.Equal(t, "minimax_h3", body["model"])
			assert.Equal(t, "cf-fl2v", body["workflow_id"])
			assert.EqualValues(t, 6, body["seconds"])
			assert.Equal(t, map[string]any{"ratio": "4k-9x16"}, body["output"])
			assert.Equal(t, []any{
				map[string]any{"type": "image", "role": "first_frame", "url": "https://example.invalid/a.png"},
				map[string]any{"type": "image", "role": "last_frame", "url": "https://example.invalid/b.png"},
			}, body["references"])
			_, _ = io.WriteString(w, `{"id":"task_up","status":"queued","progress":0}`)
		case "/v1/videos/task_up":
			assert.Equal(t, "GET", r.Method)
			polls++
			if polls == 1 {
				_, _ = io.WriteString(w, `{"id":"task_up","status":"completed","progress":100,"url":"https://example.invalid/v1/videos/task_up/content","content_url":"/v1/videos/task_up/content"}`)
				return
			}
			_, _ = io.WriteString(w, `{"id":"task_up","status":"completed","progress":100,"url":"https://cdn.example.invalid/v.mp4?sig=1","video_url":"https://cdn.example.invalid/v.mp4?sig=1"}`)
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
			"model": "H3-Video", "body": map[string]any{"kind": "json", "value": map[string]any{
				"prompt": "Fixture", "seconds": "6", "resolution": "4K", "ratio": "9:16",
				"images": []any{"https://example.invalid/a.png", "https://example.invalid/b.png"},
			}},
		})
	require.NoError(t, err)
	ctx := map[string]any{"model": "H3-Video", "upstreamModel": "minimax_h3", "publicTaskId": "task_public01",
		"baseUrl": server.URL + "/v1", "apiKey": "fixture", "requestBody": decoded.(map[string]any)["requestBody"]}
	usage := call("extractUsage", ctx).(map[string]any)
	assert.EqualValues(t, 6, usage["seconds"])
	assert.Equal(t, "4k", usage["resolution"])
	submit := call("buildSubmitRequest", ctx).(map[string]any)
	accepted := call("parseSubmitResponse", ctx, map[string]any{"body": send(submit)}).(map[string]any)
	assert.Equal(t, "task_up", accepted["taskId"])

	queryCtx := map[string]any{"taskId": "task_up", "baseUrl": server.URL, "apiKey": "fixture", "state": nil}
	query := call("buildQueryRequest", queryCtx).(map[string]any)
	waiting := call("parseTaskResult", queryCtx, send(query)).(map[string]any)
	assert.Equal(t, "IN_PROGRESS", waiting["status"])
	assert.Equal(t, "99%", waiting["progress"])
	queryCtx["state"] = waiting["state"]
	body := send(query)
	result := call("parseTaskResult", queryCtx, body).(map[string]any)
	assert.Equal(t, "SUCCESS", result["status"])
	assert.Equal(t, "100%", result["progress"])
	assert.Equal(t, "https://cdn.example.invalid/v.mp4?sig=1", result["url"])
	assert.Nil(t, call("extractUsageOnComplete", queryCtx, result, body))

	artifacts := call("listArtifacts", map[string]any{"status": "SUCCESS", "data": body}).([]any)
	require.Len(t, artifacts, 1)
	content := call("buildContentRequest", map[string]any{"artifactKey": "video", "data": body,
		"clientRequest": map[string]any{"method": "GET"}}).(map[string]any)
	assert.Equal(t, true, content["credentialless"])
	assert.Equal(t, "https://cdn.example.invalid/v.mp4?sig=1", content["url"])
	assert.Nil(t, content["headers"])
	assert.Equal(t, 2, polls)

	for _, tc := range []map[string]any{
		{"prompt": "Fixture", "duration": 0},
		{"prompt": "Fixture", "duration": 3601},
		{"prompt": "Fixture", "duration": 5, "resolution": "480p", "output": map[string]any{"ratio": "4k-16x9"}},
		{"prompt": "Fixture", "duration": true},
		{"prompt": "Fixture", "seconds": 5, "metadata": map[string]any{"seconds": 15}},
	} {
		ctx["requestBody"] = tc
		_, err := plugin.Engine.Call(context.Background(), "extractUsage", ctx)
		assert.Error(t, err)
	}
}
