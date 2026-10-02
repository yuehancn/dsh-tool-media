// End-to-end test for dsh-tool-media: every assertion below drives a REAL
// ffmpeg/ffprobe subprocess against a REAL generated video. Nothing is mocked —
// the point is to prove the plugin's argument arrays are what ffmpeg actually
// accepts, and that the two-pass size-budget logic lands near its target.
import { mkdir, rm, stat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { plugin, Context, call } from "./harness.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1"));
const FFMPEG = "C:/AI/ffmpeg/ffmpeg-release-full/bin/ffmpeg.exe";
const FFPROBE = "C:/AI/ffmpeg/ffmpeg-release-full/bin/ffprobe.exe";
const FIXTURE = join(ROOT, "_test", "fixtures", "tiny.mp4");
const OUT = join(ROOT, "_test", "tmp-out");

let pass = 0;
let fail = 0;
function t(label, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(ok ? "  PASS" : "  FAIL", label, ok ? "" : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
	if (ok) pass += 1; else fail += 1;
}
function ok(label, condition, detail) {
	console.log(condition ? "  PASS" : "  FAIL", label, condition ? "" : `— ${detail}`);
	if (condition) pass += 1; else fail += 1;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const ctx = Context({
	ffmpegPath: FFMPEG,
	ffprobePath: FFPROBE,
	outputDir: OUT,
	timeoutMs: 180000,
	maxFrames: 12
});
plugin.apply(ctx, ctx.config);

/* ------------------------------------------------------------- status --- */
console.log("media_status (real binaries):");
const status = await call(ctx.get("media_status"), {});
ok("status succeeds", status.error === undefined, status.error);
t("ffmpeg is available", status.value?.ffmpeg?.available, true);
t("ffprobe is available", status.value?.ffprobe?.available, true);
ok("ffmpeg version was read", /ffmpeg version/u.test(status.value?.ffmpeg?.version ?? ""), status.value?.ffmpeg?.version);
t("status lists all 8 targets", status.value?.targets?.length, 8);

/* -------------------------------------------------------------- probe --- */
console.log("\nmedia_probe (real ffprobe):");
const probe = await call(ctx.get("media_probe"), { path: FIXTURE });
ok("probe succeeds", probe.error === undefined, probe.error);
t("classified as video", probe.value?.kind, "video");
ok("duration is ~3s", Math.abs((probe.value?.durationSeconds ?? 0) - 3) < 0.5, String(probe.value?.durationSeconds));
t("video codec is h264", probe.value?.video?.codec, "h264");
t("video is 320x240", [probe.value?.video?.width, probe.value?.video?.height], [320, 240]);
t("audio codec is aac", probe.value?.audio?.codec, "aac");
ok("size is reported", (probe.value?.sizeBytes ?? 0) > 1000, String(probe.value?.sizeBytes));
ok("stream count is 2", probe.value?.streamCount === 2, String(probe.value?.streamCount));
const probeText = ctx.get("media_probe").output.render({}, probe.value)[0].text;
ok("render shows 320x240 @ 10fps", probeText.includes("h264 320x240 @ 10fps"), probeText);

/* ------------------------------------------------------------ convert --- */
console.log("\nmedia_convert (real transcode):");
const toGif = await call(ctx.get("media_convert"), { path: FIXTURE, target: "gif", outputName: "out.gif" });
ok("gif conversion succeeds", toGif.error === undefined, toGif.error);
const gifInfo = await stat(toGif.value?.outputPath ?? "").catch(() => undefined);
ok("gif was actually written", (gifInfo?.size ?? 0) > 0, String(gifInfo?.size));
ok("gif extension matches target", toGif.value?.outputPath?.endsWith(".gif"), toGif.value?.outputPath);

const toMp3 = await call(ctx.get("media_convert"), { path: FIXTURE, target: "mp3", outputName: "out.mp3" });
ok("mp3 conversion succeeds", toMp3.error === undefined, toMp3.error);
const mp3Info = await stat(toMp3.value?.outputPath ?? "").catch(() => undefined);
ok("mp3 was actually written", (mp3Info?.size ?? 0) > 0, String(mp3Info?.size));

const trimmed = await call(ctx.get("media_convert"), {
	path: FIXTURE, target: "mp4-h264", outputName: "trimmed.mp4", start: "0", duration: "1", width: 160, crf: 30
});
ok("trim+scale conversion succeeds", trimmed.error === undefined, trimmed.error);
const trimmedProbe = await call(ctx.get("media_probe"), { path: trimmed.value?.outputPath });
ok("trimmed clip is ~1s", Math.abs((trimmedProbe.value?.durationSeconds ?? 0) - 1) < 0.4, String(trimmedProbe.value?.durationSeconds));
t("trimmed clip was downscaled to 160 wide", trimmedProbe.value?.video?.width, 160);
ok("trimmed output is smaller than source", (trimmed.value?.sizeBytes ?? 0) < (probe.value?.sizeBytes ?? 0),
	`${trimmed.value?.sizeBytes} vs ${probe.value?.sizeBytes}`);

const muted = await call(ctx.get("media_convert"), { path: FIXTURE, target: "mp4-h264", outputName: "muted.mp4", removeAudio: true });
ok("removeAudio conversion succeeds", muted.error === undefined, muted.error);
const mutedProbe = await call(ctx.get("media_probe"), { path: muted.value?.outputPath });
t("muted clip has no audio stream", mutedProbe.value?.audio, undefined);

const unknownTarget = await call(ctx.get("media_convert"), { path: FIXTURE, target: "mkv" });
ok("unknown target is rejected at runtime", /unknown target "mkv"/u.test(unknownTarget.error ?? ""), unknownTarget.error);

/* ------------------------------------------------------------- frames --- */
console.log("\nmedia_frames (real frame extraction):");
const frames = await call(ctx.get("media_frames"), { path: FIXTURE, count: 4, format: "jpg" });
ok("frame extraction succeeds", frames.error === undefined, frames.error);
t("four frames came back", frames.value?.count, 4);
ok("all four files exist on disk",
	(await Promise.all((frames.value?.frames ?? []).map((f) => stat(f).then(() => true).catch(() => false)))).every(Boolean),
	frames.value?.frames?.join(","));
ok("frames use jpg extension", (frames.value?.frames ?? []).every((f) => f.endsWith(".jpg")), frames.value?.frames?.join(","));
ok("frames are numbered in order", frames.value?.frames?.[0]?.includes("frame01"), frames.value?.frames?.[0]);

const stamped = await call(ctx.get("media_frames"), { path: FIXTURE, timestamps: "0,1,2", format: "png" });
ok("timestamp extraction succeeds", stamped.error === undefined, stamped.error);
t("three timestamped frames", stamped.value?.count, 3);

const tooMany = await call(ctx.get("media_frames"), { path: FIXTURE, count: 50 });
ok("count above maxFrames is rejected", /count must be between 1 and 12/u.test(tooMany.error ?? ""), tooMany.error);

/* -------------------------------------------------------------- audio --- */
console.log("\nmedia_audio (real audio extraction):");
const wav = await call(ctx.get("media_audio"), { path: FIXTURE, target: "wav", sampleRate: 16000, channels: 1, outputName: "voice.wav" });
ok("wav extraction succeeds", wav.error === undefined, wav.error);
const wavProbe = await call(ctx.get("media_probe"), { path: wav.value?.outputPath });
t("wav is mono", wavProbe.value?.audio?.channels, 1);
t("wav was resampled to 16000Hz", wavProbe.value?.audio?.sampleRate, 16000);
t("wav has no video stream", wavProbe.value?.video, undefined);
ok("probe still classifies wav as audio", wavProbe.value?.kind === "audio", wavProbe.value?.kind);

const flac = await call(ctx.get("media_audio"), { path: FIXTURE, target: "flac", outputName: "lossless.flac" });
ok("flac extraction succeeds", flac.error === undefined, flac.error);
ok("flac file was written", (await stat(flac.value?.outputPath ?? "").catch(() => ({ size: 0 }))).size > 0, flac.value?.outputPath);

/* ----------------------------------------------------------- compress --- */
console.log("\nmedia_compress (real two-pass rate control):");
// Make a deliberately fat source so the budget actually bites: raw-ish H.264 at
// a very low CRF over 10 seconds, which two-pass has to squeeze down.
const FAT = join(ROOT, "_test", "fixtures", "fat.mp4");
const { spawn } = await import("node:child_process");
const makeFat = await call({ execute: () => new Promise((res, rej) => {
	const p = spawn(FFMPEG, [
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=640x480:rate=30:duration=10",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=10",
		"-c:v", "libx264", "-preset", "ultrafast", "-crf", "0", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-shortest", FAT
	], { windowsHide: true });
	p.on("close", (c) => c === 0 ? res(true) : rej(new Error(`exit ${c}`)));
	p.on("error", rej);
}) }, {});
ok("fat source video was generated", makeFat.error === undefined, makeFat.error);
const fatInfo = await stat(FAT);
console.log(`  (fat source: ${(fatInfo.size / 1048576).toFixed(2)} MB, ~10s)`);

const compressed = await call(ctx.get("media_compress"), { path: FAT, targetSizeMb: 0.5, outputName: "small.mp4" });
ok("compression succeeds", compressed.error === undefined, compressed.error);
t("two passes were run", compressed.value?.passes, 2);
ok("a video bitrate was derived", (compressed.value?.videoKbps ?? 0) >= 50, String(compressed.value?.videoKbps));
const smallInfo = await stat(compressed.value?.outputPath ?? "").catch(() => undefined);
ok("compressed file was written", (smallInfo?.size ?? 0) > 0, String(smallInfo?.size));
ok("compressed file shrank substantially", (smallInfo?.size ?? 0) < fatInfo.size * 0.35,
	`${(smallInfo?.size ?? 0) / 1048576} MB vs ${fatInfo.size / 1048576} MB`);
// Two-pass aims near the budget; allow generous slack because a 10s clip at
// 0.5 MB is an aggressive target and container overhead is not modelled.
ok("compressed file lands within 3x of the 0.5 MB target", (smallInfo?.size ?? 0) < 1.6 * 1048576,
	`${((smallInfo?.size ?? 0) / 1048576).toFixed(3)} MB`);
const compressedProbe = await call(ctx.get("media_probe"), { path: compressed.value?.outputPath });
t("compressed output is still h264", compressedProbe.value?.video?.codec, "h264");
ok("compressed output kept its audio", compressedProbe.value?.audio !== undefined, "no audio stream");
ok("compression render reports the landing", /actual:/u.test(ctx.get("media_compress").output.render({}, compressed.value)[0].text),
	ctx.get("media_compress").output.render({}, compressed.value)[0].text);

const downscaled = await call(ctx.get("media_compress"), { path: FAT, targetSizeMb: 0.8, width: 320, outputName: "small320.mp4" });
ok("compression with downscale succeeds", downscaled.error === undefined, downscaled.error);
const downProbe = await call(ctx.get("media_probe"), { path: downscaled.value?.outputPath });
t("downscaled output is 320 wide", downProbe.value?.video?.width, 320);

const impossible = await call(ctx.get("media_compress"), { path: FAT, targetSizeMb: 0.01 });
ok("impossible budget is refused with guidance", /too low to be watchable/u.test(impossible.error ?? ""), impossible.error);

/* ------------------------------------------------- path robustness ---- */
console.log("\npath robustness (CJK + spaces):");
const cjkDir = join(ROOT, "_test", "素材 目录");
await mkdir(cjkDir, { recursive: true });
const cjkSource = join(cjkDir, "测试 视频.mp4");
await stat(cjkSource).catch(async () => { await import("node:fs/promises").then(({ copyFile }) => copyFile(FIXTURE, cjkSource)); });
const cjkProbe = await call(ctx.get("media_probe"), { path: cjkSource });
ok("CJK+space path probes fine", cjkProbe.error === undefined, cjkProbe.error);
t("CJK path keeps its kind", cjkProbe.value?.kind, "video");
const cjkConvert = await call(ctx.get("media_convert"), { path: cjkSource, target: "mp3", outputName: "中文 输出.mp3" });
ok("CJK+space path converts fine", cjkConvert.error === undefined, cjkConvert.error);
ok("CJK output file exists", (await stat(cjkConvert.value?.outputPath ?? "").catch(() => ({ size: 0 }))).size > 0, cjkConvert.value?.outputPath);

console.log(`\ne2e: ${pass} passed, ${fail} failed`);
await rm(OUT, { recursive: true, force: true }).catch(() => {});
await rm(cjkDir, { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);