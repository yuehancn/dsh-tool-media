# dsh-tool-media

> **在 dsh 里直接剪转媒体** —— 探一探这个视频什么规格、转成 mp4/webm、抽几帧
> 当封面、把音轨扒出来做转写、压到 10 MB 以内再发出去。

给 **DeepSeek Harness** 用的自建工具插件：把本机 ffmpeg 包成 6 个结构化工具。

> **Compatibility**: built and tested against dsh `0.2.0-rc.2` (preview).
> The `apply(ctx)` plugin spec is stable; verify against your own dsh version if newer.

---

## 一行安装

```bash
dsh plugin --profile desktop add github:yuehancn/dsh-tool-media
```

**支持的 profile**：`desktop`（桌面版）/ `web`（Web 版）。装完重启 dsh 即可用。

---

## 为什么需要它

Agent 拿到一个视频，只能靠猜 —— 多长？多大？什么编码？猜错就得重跑一次转码。
这个插件把「猜」换成「问」：

```
media_probe  →  时长 2:13 / 1920x1080 / h264 + aac / 48.2 MB
media_compress(targetSizeMb=10)  →  两遍编码，落在 9.8 MB
```

**关键设计**：`media_compress` 按**字节预算**压，不是给你一个画质旋钮。
因为真实需求就是「给我压到 10 MB 以内」，而从预算反推码率、再跑两遍编码
让它真的落在 10 MB —— 这才是值得自动化的部分。

---

## 六个工具

### `media_status`
探 ffmpeg / ffprobe 能不能跑、版本是多少，并列出可用的转换目标。
**长任务前先问一句**，避免等到超时才发现在 PATH 里找不到 ffmpeg。

### `media_probe(path)`
返回结构化事实：时长、体积、码率、封装格式、视频流（编码/分辨率/帧率/像素格式）、
音频流（编码/采样率/声道数）、流数量。

### `media_convert(path, target, ...)`
可用 target：

| target | 容器 | 视频编码 | 音频编码 |
|---|---|---|---|
| `mp4-h264` | mp4 | libx264 | aac |
| `mp4-h265` | mp4 | libx265 | aac |
| `webm` | webm | libvpx-vp9 | libopus |
| `gif` | gif | gif | — |
| `mp3` / `wav` / `aac` / `flac` | 各自容器 | — | 对应编码 |

可选：`width`（等比缩放，自动取偶数）、`start` + `duration`（裁剪）、
`crf`（0–51，越小越好）、`removeAudio`。

### `media_frames(path, count | timestamps, format)`
抽帧。**默认在整段视频上均匀取**（不是开头 N 秒）—— 因为「给我几帧」
几乎总是「铺开看看」。也可以给显式时间戳 `"0,5,12.5"`。

### `media_audio(path, target, sampleRate, channels)`
扒音轨。默认输出 **wav**（无损，做语音转写最合适）；
要喂给 ASR 就加 `sampleRate=16000, channels=1`。

### `media_compress(path, targetSizeMb, audioKbps, width)`
按目标体积压缩，走 **ffmpeg 两遍编码**，结果贴着预算而不是超出去。
预算小到算出来的视频码率低于 50 kbps 时会**直接报错**告诉你要么放宽预算、
要么先裁短 —— 而不是默默产出不可看的片子。

---

## 配置

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: tool-media
  config:
    ffmpegPath: C:/AI/ffmpeg/ffmpeg-release-full/bin/ffmpeg.exe
    ffprobePath: C:/AI/ffmpeg/ffmpeg-release-full/bin/ffprobe.exe
    outputDir: C:/Users/you/Videos/media-output
    maxFrames: 60
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `ffmpegPath` | `ffmpeg` | ffmpeg 可执行文件 |
| `ffprobePath` | `ffprobe` | ffprobe 可执行文件 |
| `outputDir` | `media-output` | 产物目录 |
| `timeoutMs` | 900000 | 单次调用预算（15 分钟） |
| `maxFrames` | 60 | 单次最多抽多少帧 |
| `probe`/`convert`/`frames`/`audio`/`compress`/`status` | `true` | 按需关掉某个工具 |

**Windows 装 ffmpeg**：下载 gyan.dev 的 full build，解压后把 `bin` 目录
写进 `ffmpegPath`（或加进 PATH）。`ffmpeg -version` 能出版本号即可。

---

## 安全说明

- 只用 `spawn(command, argsArray)` 调用 —— **不拼 shell 字符串**，
  路径里有空格、引号、中文都不会出事。
- 只读写你指定的输入文件与 `outputDir`，不上传、不联网。
- `-y` 只作用于 `outputDir` 内的产物；不会覆盖你的源文件
  （源文件路径从不作为输出）。

---

## 跑测试

```bash
mkdir -p node_modules/@deepseek-ai
cp -r "$HOME/.dsh/profiles/desktop/node_modules/@deepseek-ai/." node_modules/@deepseek-ai/
node _test/run-all.mjs
```

三个套件，**159 条断言全绿**（对着真实 `@deepseek-ai/dsh-tools` 跑，不 mock）：

| 套件 | 断言 | 内容 |
|---|---|---|
| `test-logic.mjs` | 48 | 类型判定、时长格式化、帧率分数解析、`TARGETS` 表、`Config` 默认值与覆盖 |
| `test-integration.mjs` | 53 | 模块导出、注册数量、`defineTool` schema 归一化、六个开关、12 条错误路径、卡片标题、输出渲染 |
| `test-e2e.mjs` | 58 | **真 ffmpeg 子进程**：真造素材 → 真探 → 真转 gif/mp3/裁剪/静音 → 真抽帧 → 真扒音轨（含重采样到 16k 单声道）→ 真两遍压缩（6.89 MB → <1.6 MB）→ 中文带空格路径 |

`test-e2e.mjs` 需要 `C:/AI/ffmpeg/ffmpeg-release-full/bin/` 下的 ffmpeg/ffprobe；
`_test/fixtures/tiny.mp4` 已随仓库提供（3 秒 320x240 带音轨，用 ffmpeg 的 `testsrc` + `sine` 生成）。

---

## 许可

MIT