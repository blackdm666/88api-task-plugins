import assert from 'node:assert/strict'
import test from 'node:test'
import * as plugin from '../plugins/xm-video/plugin.js'

const RID = '0217910000000000000000000000000000000000000000000abcd'
const reason = message => plugin.parseTaskResult({}, { status: 'failed', error: { message } }).reason
const render = message => plugin.protocols.openai_video.render({}, { status: 'FAILURE', fail_reason: message }).error.message

// Inputs follow the shapes observed in production failures; ids, links and
// model names are fixtures.
const CASES = [
  ['上游任务失败: Input Prompt violates policy',
    '提示词未通过内容安全审核，请修改提示词后重试。'],
  ['Input Prompt violates policy',
    '提示词未通过内容安全审核，请修改提示词后重试。'],
  ['上游任务失败: 1500000000-AigcVideoTask-0123456789abcdef0123456789abcdeft status=failed msg=上游任务失败: Input Prompt violates policy',
    '提示词未通过内容安全审核，请修改提示词后重试。'],
  ['上游任务失败: task failed with status: FAIL, message: The request failed because the output video may contain sensitive information',
    '生成的视频可能包含敏感内容，已被内容安全策略拦截。请调整提示词或参考素材后重试。'],
  ['上游任务失败: task failed with status: FAIL, message: The request failed because the output video may be related to copyright restrictions',
    '生成的视频可能涉及版权限制，已被内容安全策略拦截。请避免在提示词或参考素材中使用受版权保护的角色、作品或品牌，修改后重试。'],
  ['上游任务失败: task failed with status: FAIL, message: The request failed because the output audio may be related to copyright restrictions',
    '生成的音频可能涉及版权限制，已被内容安全策略拦截。请避免使用受版权保护的音乐、歌曲或声音，修改提示词或参考音频后重试。'],
  [`上游任务失败: task failed with status: FAIL, message: The request failed because the input image 'content[1]' may be related to copyright restrictions. Request id: ${RID}`,
    `输入图片 content[1] 可能涉及版权限制，已被内容安全策略拦截。请更换为您拥有版权或无版权限制的图片后重试。 请求 ID：${RID}。`],
  [`上游任务失败: task failed with status: FAIL, message: The request failed because the input video 'content[2]' may be related to copyright restrictions. Request id: ${RID}`,
    `输入视频 content[2] 可能涉及版权限制，已被内容安全策略拦截。请更换为您拥有版权或无版权限制的视频后重试。 请求 ID：${RID}。`],
  [`上游任务失败: task failed with status: FAIL, message: The request failed because the input image 'content[1]' 'content[3]' may contain real person. Request id: ${RID}`,
    `输入图片 content[1]、content[3] 可能包含真人或可识别人物，已被内容安全策略拦截。请更换不含真人或可识别人物的图片后重试。 请求 ID：${RID}。`],
  [`上游任务失败: task failed with status: FAIL, message: The request failed because the input text 'content[0]' may contain sensitive information. Request id: ${RID}`,
    `提示词可能包含敏感内容，已被内容安全策略拦截。请修改提示词后重试。 请求 ID：${RID}。`],
  [`OutputVideoSensitiveContentDetected: The request failed because the output video may contain sensitive information. Request id: ${RID}`,
    `生成的视频可能包含敏感内容，已被内容安全策略拦截。请调整提示词或参考素材后重试。 错误码：OutputVideoSensitiveContentDetected。 请求 ID：${RID}。`],
  [`上游任务失败: task_fixture0000000000000000000000 status=failed msg=OutputVideoSensitiveContentDetected.PolicyViolation: The request failed because the output video may be related to copyright restrictions. Request id: ${RID}`,
    `生成的视频可能涉及版权限制，已被内容安全策略拦截。请避免在提示词或参考素材中使用受版权保护的角色、作品或品牌，修改后重试。 错误码：OutputVideoSensitiveContentDetected.PolicyViolation。 请求 ID：${RID}。`],
  [`orphan recovery: OutputAudioSensitiveContentDetected.PolicyViolation: The request failed because the output audio may be related to copyright restrictions. Request id: ${RID}`,
    `生成的音频可能涉及版权限制，已被内容安全策略拦截。请避免使用受版权保护的音乐、歌曲或声音，修改提示词或参考音频后重试。 错误码：OutputAudioSensitiveContentDetected.PolicyViolation。 请求 ID：${RID}。`],
  ['task_failed: The request failed because the output video may be related to copyright restrictions',
    '生成的视频可能涉及版权限制，已被内容安全策略拦截。请避免在提示词或参考素材中使用受版权保护的角色、作品或品牌，修改后重试。'],
  ['OutputVideoCopyright',
    '生成的视频可能涉及版权限制，已被内容安全策略拦截。请避免在提示词或参考素材中使用受版权保护的角色、作品或品牌，修改后重试。'],
  ['InputVideoRisk', '输入视频未通过内容安全审核，请更换视频后重试。'],
  ['上游任务失败: 1200000000-AigcVideoTask-0123456789abcdef0123456789abcdeft status=failed msg=task failed with status: FAIL, message: Input ImageInfos contains prohibited content.',
    '输入图片包含违规内容，已被内容安全策略拦截。请更换图片后重试。'],
  [`上游任务失败: task failed with status: FAIL, message: The parameter ratio specified in the request is not valid. For first-frame or first-last-frame generation, the output ratio follows the first-frame image. Request id: ${RID}`,
    `首帧或首尾帧生成时，输出画幅比例跟随首帧图片，请改用与首帧图片一致的比例或不指定比例后重试。 请求 ID：${RID}。`],
  [`上游任务失败: task failed with status: FAIL, message: The parameter \`content\` specified in the request is not valid: the parameter audio total duration (seconds) specified in the request must be less than or equal to 30.2 for model fixture-model in r2v. Request id: ${RID}`,
    `输入音频总时长不能超过 30.2 秒，请调整后重试。 请求 ID：${RID}。`],
  [`上游任务失败: task failed with status: FAIL, message: The parameter \`content[2]\` specified in the request is not valid: the parameter audio duration (seconds) specified in the request must be greater than or equal to 1.8 for model fixture-model in r2v. Request id: ${RID}`,
    `输入音频 content[2] 时长不能少于 1.8 秒，请调整后重试。 请求 ID：${RID}。`],
  ['上游任务失败: task_fixture0000000000000000000000 status=failed msg=task_failed: Upstream submit failed (400): {"code":"fail_to_fetch_task","message":"{\\"error\\":{\\"code\\":\\"InvalidParameter\\",\\"message\\":\\"The parameter `content[3]` specified in the request is not valid: the parameter video duration (seconds) specified in the request must be less than or equal to 15.2 for model fixture-model in r2v\\"}}"}',
    '输入视频 content[3] 时长不能超过 15.2 秒，请调整后重试。 错误码：InvalidParameter。'],
  ['task_failed: Upstream submit failed (400): {"error":{"message":"The parameter `content[1].image_url.url` specified in the request is not valid: The specified asset asset-20261001000000-abcde is not found","type":"invalid_request_error","code":"InvalidParameter","param":"content[1].image_url.url"}}',
    '输入素材 content[1] 不存在或已失效，请重新上传素材后重试。 错误码：InvalidParameter。'],
  ['task_failed: Upstream submit failed (400): {"error":{"message":"The specified asset is not found"}}',
    '输入素材不存在或已失效，请重新上传素材后重试。'],
  ['task_failed: Upstream submit failed (400): {"error":',
    '请求参数或素材无效，任务提交失败，请检查后重试。'],
  ['上游任务失败: task failed with status: FAIL, message: The parameter inner_generation_options.pe_classification specified in the request is not valid: You requested the reference generation task type, but Seedance classified your task as video extension based on your prompt and input',
    '提示词和参考素材被识别为「视频延长」任务，与所选的「参考生成」类型不一致，请调整提示词或参考素材后重试。'],
  ['上游任务失败: task failed with status: FAIL, message: input media detect failed: invalid_media',
    '输入素材格式无效或无法识别，请更换素材后重试。'],
  ['上游任务失败: 1200000000-AigcVideoTask-0123456789abcdef0123456789abcdeft status=failed msg=task failed with status: FAIL, message: Image pixel is invalid',
    '输入图片的像素尺寸不符合要求，请更换图片后重试。'],
  ['上游任务失败: task_fixture0000000000000000000000 status=failed msg=face asset upload failed after 3 attempts (source_url=https://example.invalid/a.png submitted_url=https://example.invalid/b.png VendorError: vendor API error [InvalidParameter.PixelCountTooSmall]: Pixel count must be between 407696 and 8295044. (raw: map[ResponseMetadata:map[Action:CreateAsset',
    '输入图片像素过少，总像素数需在 407696 到 8295044 之间，请更换更高分辨率的图片后重试。'],
  ['task_failed: Reference material @Image1 could not be prepared: Width must be between 300px and 6000px',
    '参考素材 @Image1 的宽度需在 300px 到 6000px 之间，请调整后重试。'],
  ['上游任务失败: task_fixture0000000000000000000000 status=failed msg=task_failed: Reference material @Image3 could not be prepared: Height must be between 300px and 6000px',
    '参考素材 @Image3 的高度需在 300px 到 6000px 之间，请调整后重试。'],
  ['audio_file_2：音频短于 2 秒：实际 1.750167，上限 2',
    '输入音频 audio_file_2 时长不能少于 2 秒（当前 1.75 秒），请调整后重试。'],
  ['上游任务失败: 00000000-0000-4000-8000-000000000000 status=failed msg=https://example.invalid/clip.mp4 duration should be at most 15s, got 23.0s',
    '输入视频时长不能超过 15 秒（当前 23 秒），请裁剪后重试。'],
  ['上游任务失败: 00000000-0000-4000-8000-000000000000 status=failed msg=reference_video total duration 60.0s exceeds max 15s',
    '输入视频总时长不能超过 15 秒（当前 60 秒），请裁剪后重试。'],
  ['上游任务失败: 00000000-0000-4000-8000-000000000000 status=failed msg=input_video_duration(15.0s) + duration(23.0s) = 38.0s exceeds 30s limit',
    '输入视频时长与生成时长合计不能超过 30 秒（当前 15 + 23 = 38 秒），请缩短后重试。'],
  ["上游任务失败: 00000000-0000-4000-8000-000000000000 status=failed msg=Input should be '1080P', '720P' or '480P': parameters.resolution",
    '分辨率参数无效，请选择：1080P、720P、480P。'],
  ['上游任务失败: 1500000000-AigcVideoTask-0123456789abcdef0123456789abcdeft status=failed msg=上游任务失败: Input 0 data is invalid (too short), index:1',
    '输入素材数据无效（内容过短或已损坏），请更换素材后重试。'],
  ['上游任务失败: task failed with status: FAIL, message: task time out.',
    '视频生成超时，任务未能完成，请稍后重新提交。'],
  ['上游任务失败: task failed with status: FAIL, message: unexpected fixture state, see https://example.invalid/status',
    'unexpected fixture state, see [链接]'],
]

test('provider failures become Chinese guidance without provider wrappers', () => {
  for (const [input, want] of CASES) {
    assert.equal(reason(input), want, input)
    assert.doesNotMatch(want, /上游|Upstream|https?:|fixture-model|Vendor|AigcVideoTask|status=failed/)
  }
})

test('poll, submit and the stored-reason render agree, and rendering is idempotent', () => {
  for (const [input, want] of CASES) {
    assert.throws(() => plugin.parseSubmitResponse({}, { body: { status: 'failed', error: { message: input } } }), { message: want })
    assert.equal(render(input), want)
    assert.equal(render(want), want)
    assert.equal(reason(want), want)
  }
})

test('busy and unrelated messages keep their previous behaviour', () => {
  const busy = '生成服务繁忙，任务未能完成，请稍后重试。'
  assert.equal(reason('上游任务失败: task failed with status: FAIL, message: JsonDecode response failed'), busy)
  assert.equal(reason('task_failed: Upstream submit failed (429): {"error":{"message":"Request rate limit exceeded for this API key"}}'), busy)
  for (const message of ['fixture upstream validation: unsupported media', '视频生成失败，请稍后重试。', 'Unexpected status code: 422']) {
    assert.equal(reason(message), message)
  }
})
