// Integration test for dsh-tool-media against the REAL @deepseek-ai/dsh-tools
// runtime. Registers the plugin into a minimal cordis-like context whose
// `tools.register` records definitions, then asserts the shapes the harness
// actually requires — tool count, schema normalization, toggles, error paths.
import { plugin, Context, call } from "./harness.mjs";

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

/* ---------------------------------------------------- module surface ---- */
console.log("module surface:");
t("exports name", typeof plugin.name, "string");
t("name value", plugin.name, "tool-media");
t("inject declares tools", plugin.inject, ["tools"]);
t("apply is a function", typeof plugin.apply, "function");
t("Config is a function", typeof plugin.Config, "function");

/* ------------------------------------------------- registration count --- */
console.log("registration:");
const all = Context();
plugin.apply(all, all.config);
t("registers 6 tools", all.names().length, 6);
t("names are stable", all.names().sort(),
	["media_audio", "media_compress", "media_convert", "media_frames", "media_probe", "media_status"]);

/* ------------------------------------------------ schema normalization -- */
console.log("schema shape (defineTool normalization):");
const probe = all.get("media_probe");
t("probe parameters type", probe.parameters.type, "object");
ok("probe path is a property", "path" in probe.parameters.properties, JSON.stringify(probe.parameters.properties));
t("probe required is top-level array", probe.parameters.required, ["path"]);
t("probe output schema exists", probe.output.schema.type, "object");
ok("probe output requires path", probe.output.schema.required.includes("path"), JSON.stringify(probe.output.schema.required));
t("probe declares timeoutMs", typeof probe.timeoutMs, "number");

const convert = all.get("media_convert");
t("convert required", convert.parameters.required.sort(), ["path", "target"]);
t("convert optional width survives", convert.parameters.properties.width.type, "integer");
t("convert optional removeAudio survives", convert.parameters.properties.removeAudio.type, "boolean");

const compress = all.get("media_compress");
t("compress required", compress.parameters.required.sort(), ["path", "targetSizeMb"]);
t("compress targetSizeMb is number", compress.parameters.properties.targetSizeMb.type, "number");

const frames = all.get("media_frames");
t("frames required", frames.parameters.required, ["path"]);
t("frames count is integer", frames.parameters.properties.count.type, "integer");

const audio = all.get("media_audio");
t("audio required", audio.parameters.required, ["path"]);

const status = all.get("media_status");
t("status has empty parameters", Object.keys(status.parameters.properties).length, 0);

/* ------------------------------------------------------------- toggles -- */
console.log("toggles:");
const none = Context({ status: false, probe: false, convert: false, frames: false, audio: false, compress: false });
plugin.apply(none, none.config);
t("all off registers nothing", none.names().length, 0);

const onlyProbe = Context({ status: false, convert: false, frames: false, audio: false, compress: false });
plugin.apply(onlyProbe, onlyProbe.config);
t("only probe on", onlyProbe.names(), ["media_probe"]);

const noStatus = Context({ status: false });
plugin.apply(noStatus, noStatus.config);
t("status off drops one", noStatus.names().length, 5);
ok("status off really removes it", !noStatus.names().includes("media_status"), noStatus.names().join(","));

/* ------------------------------------------------------- error paths ---- */
console.log("error paths (execute against real fs):");
const ctx = Context({ outputDir: "./_test/tmp-out" });
plugin.apply(ctx, ctx.config);

const missing = await call(ctx.get("media_probe"), { path: "./_test/definitely-absent.mp4" });
ok("missing file rejects", missing.error !== undefined, "expected a rejection");
ok("missing file message is actionable", /no file at/u.test(missing.error ?? ""), missing.error);

const badTarget = await call(ctx.get("media_convert"), { path: "./_test/fixtures/not-a-file.mp4", target: "mkv" });
ok("missing source checked before target", /no file at/u.test(badTarget.error ?? ""), badTarget.error);

const badFormatFrames = await call(ctx.get("media_frames"), { path: "./_test/fixtures/tiny.mp4", format: "bmp" });
ok("frames rejects unsupported format", /format must be png or jpg/u.test(badFormatFrames.error ?? ""), badFormatFrames.error);

const badCount = await call(ctx.get("media_frames"), { path: "./_test/fixtures/tiny.mp4", count: 999 });
ok("frames rejects count over maxFrames", /count must be between/u.test(badCount.error ?? ""), badCount.error);

const tooManyStamps = await call(ctx.get("media_frames"),
	{ path: "./_test/fixtures/tiny.mp4", timestamps: Array.from({ length: 99 }, (_u, i) => String(i)).join(",") });
ok("frames rejects too many timestamps", /exceeds maxFrames/u.test(tooManyStamps.error ?? ""), tooManyStamps.error);

const badCrf = await call(ctx.get("media_convert"), { path: "./_test/fixtures/tiny.mp4", target: "mp4-h264", crf: 99 });
ok("convert rejects out-of-range crf", /crf must be between/u.test(badCrf.error ?? ""), badCrf.error);

const oddWidth = await call(ctx.get("media_convert"), { path: "./_test/fixtures/tiny.mp4", target: "mp4-h264", width: 641 });
ok("convert rejects odd width", /width must be a positive even number/u.test(oddWidth.error ?? ""), oddWidth.error);

const audioWidth = await call(ctx.get("media_convert"), { path: "./_test/fixtures/tiny.mp4", target: "mp3", width: 320 });
ok("convert rejects width on audio target", /audio-only/u.test(audioWidth.error ?? ""), audioWidth.error);

const badAudioTarget = await call(ctx.get("media_audio"), { path: "./_test/fixtures/tiny.mp4", target: "mp4-h264" });
ok("audio rejects a video target", /target must be one of wav, mp3, aac, flac/u.test(badAudioTarget.error ?? ""), badAudioTarget.error);

// media_compress probes for duration, so give it a real file to reach the
// bitrate floor. The e2e suite covers the happy path.
const ctxFloor = Context({ outputDir: "./_test/tmp-out", ffprobePath: "ffprobe" });
plugin.apply(ctxFloor, ctxFloor.config);
const floor = await call(ctxFloor.get("media_compress"), { path: "./_test/fixtures/tiny.mp4", targetSizeMb: 0.0001 });
ok("compress rejects an impossible budget", /too low to be watchable/u.test(floor.error ?? ""), floor.error);

const negative = await call(ctxFloor.get("media_compress"), { path: "./_test/fixtures/tiny.mp4", targetSizeMb: -5 });
ok("compress rejects a negative budget", /positive number/u.test(negative.error ?? ""), negative.error);

/* --------------------------------------------------------- presentation - */
console.log("presentation:");
const probeCard = all.get("media_probe").presentCall({ path: "C:/clips/a.mp4" });
t("probe card title", probeCard.title, "Probe: a.mp4");
const convertCard = all.get("media_convert").presentCall({ path: "C:/clips/a.mp4", target: "mp4-h264" });
t("convert card title", convertCard.title, "Convert a.mp4 → mp4-h264");
const compressCard = all.get("media_compress").presentCall({ path: "C:/clips/a.mp4", targetSizeMb: 10 });
t("compress card title", compressCard.title, "Compress a.mp4 → 10 MB");
const framesCard = all.get("media_frames").presentCall({ path: "C:/clips/a.mp4" });
t("frames card title", framesCard.title, "Frames from a.mp4");
const audioCard = all.get("media_audio").presentCall({ path: "C:/clips/a.mp4" });
t("audio card title", audioCard.title, "Extract audio: a.mp4");

/* ------------------------------------------------------------- renders -- */
console.log("output render:");
const probeRender = all.get("media_probe").output.render({}, {
	path: "C:/a.mp4", kind: "video", formatName: "mov,mp4,m4a", durationSeconds: 65,
	sizeBytes: 2097152, streamCount: 2,
	video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
	audio: { codec: "aac", sampleRate: 48000, channels: 2 }
});
const probeText = probeRender[0].text;
ok("probe render names duration", probeText.includes("1:05 (65s)"), probeText);
ok("probe render names resolution", probeText.includes("h264 1920x1080 @ 30fps"), probeText);
ok("probe render names audio", probeText.includes("aac 48000Hz 2ch"), probeText);
ok("probe render names size", probeText.includes("2.00 MB"), probeText);

const statusRender = all.get("media_status").output.render({}, {
	ffmpeg: { command: "ffmpeg", available: true, version: "ffmpeg version 7.1" },
	ffprobe: { command: "ffprobe", available: false, error: "ENOENT" },
	targets: ["mp4-h264", "gif"]
});
const statusText = statusRender[0].text;
ok("status render shows ffmpeg available", statusText.includes("AVAILABLE ffmpeg version 7.1"), statusText);
ok("status render shows ffprobe missing", statusText.includes("MISSING — ENOENT"), statusText);
ok("status render lists targets", statusText.includes("mp4-h264, gif"), statusText);

const compressRender = all.get("media_compress").output.render({}, {
	source: "C:/a.mp4", outputPath: "C:/out/a.compressed.mp4",
	targetSizeBytes: 10485760, sizeBytes: 10276044, videoKbps: 1150, passes: 2
});
ok("compress render reports the landing", /actual: 9\.80 MB/u.test(compressRender[0].text), compressRender[0].text);
ok("compress render reports bitrate", compressRender[0].text.includes("1150 kbps over 2 passes"), compressRender[0].text);

const framesRender = all.get("media_frames").output.render({}, {
	source: "C:/a.mp4", count: 2, frames: ["C:/out/a.frame01.png", "C:/out/a.frame02.png"]
});
ok("frames render lists outputs", framesRender[0].text.includes("- C:/out/a.frame02.png"), framesRender[0].text);

console.log(`\nintegration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);