// Runtime test for dsh-tool-media pure logic, using the real schemastery module.
// The plugin builds its Config schema at load time, so a faithful stub is not
// enough — we import the genuine module and rebuild the source with its imports
// stripped, then pull the helpers back out of the factory.
import { readFile } from "node:fs/promises";
import { extname, basename, resolve, join } from "node:path";

const src = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
const body = src
	.replace(/^import .*$/gm, "")
	.replace(/^export \{.*\};$/m, "");

const z = (await import("@deepseek-ai/schemastery")).default;
const defineTool = (def) => def;
const factory = new Function(
	"z",
	"defineTool",
	"extname",
	"basename",
	"resolve",
	"join",
	`${body}\nreturn { classify, humanDuration, parseFraction, Config, TARGETS, DEFAULT_TIMEOUT_MS };`
);
const { classify, humanDuration, parseFraction, Config, TARGETS, DEFAULT_TIMEOUT_MS } =
	factory(z, defineTool, extname, basename, resolve, join);

let pass = 0;
let fail = 0;
function t(label, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(ok ? "  PASS" : "  FAIL", label, ok ? "" : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
	if (ok) pass += 1; else fail += 1;
}

console.log("classify:");
t("mp4", classify("/a/b.mp4"), "video");
t("uppercase MKV", classify("/a/b.MKV"), "video");
t("mov", classify("clip.mov"), "video");
t("ts", classify("stream.ts"), "video");
t("mp3", classify("/a/b.mp3"), "audio");
t("flac upper", classify("/a/b.FLAC"), "audio");
t("m4a", classify("voice.m4a"), "audio");
t("png", classify("/a/b.png"), "image");
t("jpeg", classify("shot.jpeg"), "image");
t("webp", classify("shot.webp"), "image");
t("unknown ext", classify("/a/b.xyz"), "unknown");
t("no ext", classify("/a/b"), "unknown");
t("cjk with video ext", classify("C:/我的视频/素材.MP4"), "video");

console.log("humanDuration:");
t("zero", humanDuration(0), "0:00");
t("5s", humanDuration(5), "0:05");
t("65s", humanDuration(65), "1:05");
t("3600s", humanDuration(3600), "1:00:00");
t("3695s", humanDuration(3695), "1:01:35");
t("rounds up", humanDuration(59.6), "1:00");
t("NaN", humanDuration(Number.NaN), "unknown");
t("Infinity", humanDuration(Number.POSITIVE_INFINITY), "unknown");

console.log("parseFraction:");
t("30000/1001", parseFraction("30000/1001"), 29.97);
t("25/1", parseFraction("25/1"), 25);
t("0/0", parseFraction("0/0"), undefined);
t("undefined", parseFraction(undefined), undefined);
t("bare number", parseFraction("30"), 30);
t("denominator zero", parseFraction("30/0"), 30);
t("non numeric", parseFraction("abc"), undefined);

console.log("TARGETS:");
t("has 8 targets", Object.keys(TARGETS).length, 8);
t("mp4-h264 container", TARGETS["mp4-h264"].container, "mp4");
t("mp4-h264 vcodec", TARGETS["mp4-h264"].vcodec, "libx264");
t("mp4-h265 vcodec", TARGETS["mp4-h265"].vcodec, "libx265");
t("gif is audio-less", TARGETS.gif.acodec, null);
t("mp3 is video-less", TARGETS.mp3.vcodec, null);
t("wav acodec", TARGETS.wav.acodec, "pcm_s16le");
t("aac container is m4a", TARGETS.aac.container, "m4a");
t("faststart on h264", TARGETS["mp4-h264"].extra.includes("+faststart"), true);

console.log("Config:");
t("Config is a function", typeof Config, "function");
const resolved = Config({});
t("default ffmpegPath", resolved.ffmpegPath, "ffmpeg");
t("default ffprobePath", resolved.ffprobePath, "ffprobe");
t("default outputDir", resolved.outputDir, "media-output");
t("default timeoutMs", resolved.timeoutMs, DEFAULT_TIMEOUT_MS);
t("default maxFrames", resolved.maxFrames, 60);
t("all six toggles default true",
	[resolved.status, resolved.probe, resolved.convert, resolved.frames, resolved.audio, resolved.compress],
	[true, true, true, true, true, true]);
const overridden = Config({ ffmpegPath: "C:/AI/ffmpeg/ffmpeg.exe", maxFrames: 12, frames: false });
t("override ffmpegPath", overridden.ffmpegPath, "C:/AI/ffmpeg/ffmpeg.exe");
t("override maxFrames", overridden.maxFrames, 12);
t("override frames toggle", overridden.frames, false);
t("untouched probe stays true", overridden.probe, true);

console.log(`\nlogic: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);