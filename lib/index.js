/**
 * Model-facing media tools over a local ffmpeg install: probe a file, transcode
 * it, pull frames or a soundtrack out of it, and shrink it to a size budget.
 *
 * This plugin owns the model-facing schemas (target format, resolution, CRF,
 * size budget, frame timestamps), the presentation, and the two-pass logic that
 * a raw shell call cannot express. It shells out to `ffmpeg` / `ffprobe` with an
 * argument array — never a concatenated command string — so paths containing
 * spaces, quotes or CJK characters survive intact.
 *
 * Design notes
 * - `media_probe` exists because a coding agent otherwise guesses at streams.
 *   It returns duration, dimensions, codecs and bitrate as structured fields,
 *   so the model can plan a transcode instead of discovering it failed.
 * - `media_compress` aims at a *byte budget* rather than a quality knob: that is
 *   the shape the real request takes ("get this under 10 MB"), and turning a
 *   budget into a bitrate is the part worth automating. It runs ffmpeg's own
 *   two-pass rate control, so the result lands near the target instead of
 *   overshooting.
 * - Frame extraction defaults to even spacing across the whole clip rather than
 *   the first N seconds, because "give me some frames" almost always means
 *   "spread over the video".
 * @module dsh-tool-media
 */
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-media";

/** Services required by the media tool suite. */
const inject = ["tools"];

/** Default cooperative tool-call budget (ms). */
const DEFAULT_TIMEOUT_MS = 900000;

/** Extensions treated as video. */
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".wmv", ".m4v", ".ts", ".mpg", ".mpeg"]);

/** Extensions treated as audio. */
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".opus", ".wma"]);

/** Image extensions, so a still can be probed too. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);

/** Container/codec defaults per output target, so the caller names an intent. */
const TARGETS = {
	"mp4-h264": { container: "mp4", vcodec: "libx264", acodec: "aac", extra: ["-preset", "medium", "-movflags", "+faststart"] },
	"mp4-h265": { container: "mp4", vcodec: "libx265", acodec: "aac", extra: ["-preset", "medium", "-movflags", "+faststart"] },
	webm: { container: "webm", vcodec: "libvpx-vp9", acodec: "libopus", extra: ["-b:v", "0", "-crf", "32"] },
	"gif": { container: "gif", vcodec: "gif", acodec: null, extra: [] },
	"mp3": { container: "mp3", vcodec: null, acodec: "libmp3lame", extra: ["-q:a", "2"] },
	"wav": { container: "wav", vcodec: null, acodec: "pcm_s16le", extra: [] },
	"aac": { container: "m4a", vcodec: null, acodec: "aac", extra: ["-b:a", "192k"] },
	"flac": { container: "flac", vcodec: null, acodec: "flac", extra: [] }
};

/* ------------------------------------------------------------------ config */

const Config = z.object({
	/** Path to the ffmpeg executable. */
	ffmpegPath: z.string().default("ffmpeg"),
	/** Path to the ffprobe executable. */
	ffprobePath: z.string().default("ffprobe"),
	/** Directory for produced files. */
	outputDir: z.string().default("media-output"),
	/** Cooperative tool-call budget attached as `ToolDefinition.timeoutMs`. */
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
	/** Register `media_probe`. Defaults to true. */
	probe: z.boolean().default(true),
	/** Register `media_convert`. Defaults to true. */
	convert: z.boolean().default(true),
	/** Register `media_frames`. Defaults to true. */
	frames: z.boolean().default(true),
	/** Register `media_audio`. Defaults to true. */
	audio: z.boolean().default(true),
	/** Register `media_compress`. Defaults to true. */
	compress: z.boolean().default(true),
	/** Register `media_status`. Defaults to true. */
	status: z.boolean().default(true),
	/** Upper bound on frames one call may extract. */
	maxFrames: z.number().default(60)
});

/* ---------------------------------------------------------------- process */

/**
 * Run a command and capture output with a hard timeout. A non-zero exit surfaces
 * ffmpeg's own last stderr lines, which name the actual problem (missing codec,
 * bad filter, unreadable stream) far better than a bare exit code.
 *
 * @param {string} command - executable to spawn.
 * @param {string[]} args - argument array (never a shell string).
 * @param {{timeoutMs: number, signal?: AbortSignal, cwd?: string}} options - run options.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>} captured result.
 */
function runCommand(command, args, options) {
	return new Promise((resolvePromise, reject) => {
		let child;
		try {
			child = spawn(command, args, { cwd: options.cwd, windowsHide: true, shell: false });
		} catch (error) {
			reject(new Error(`media: cannot start "${command}" (${error?.message ?? error}). Check ffmpegPath/ffprobePath in the plugin config.`));
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			fn(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(reject, new Error(`media: "${command}" exceeded its ${Math.round(options.timeoutMs / 1000)}s budget. Raise timeoutMs, shrink the input, or lower preset/quality.`));
		}, options.timeoutMs);
		const onAbort = () => {
			child.kill("SIGKILL");
			finish(reject, options.signal?.reason ?? new Error("aborted"));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", (error) => {
			finish(reject, new Error(`media: "${command}" failed to run (${error?.message ?? error}). Install ffmpeg or set ffmpegPath to its full path.`));
		});
		child.on("close", (code) => {
			if (code !== 0) {
				const tail = stderr.trim().split(/\r?\n/u).slice(-6).join("\n");
				finish(reject, new Error(`media: "${command}" exited with code ${code}.\n${tail.slice(0, 600) || "(no stderr)"}`));
				return;
			}
			finish(resolvePromise, { stdout, stderr, code: code ?? 0 });
		});
	});
}

/** Probe an executable's version string. */
async function probeBinary(command) {
	try {
		const { stdout, stderr } = await runCommand(command, ["-version"], { timeoutMs: 15000 });
		return { available: true, version: `${stdout}${stderr}`.trim().split(/\r?\n/u)[0] ?? "" };
	} catch (error) {
		return { available: false, error: String(error?.message ?? error) };
	}
}

/* ------------------------------------------------------------------ files */

/** Classify an input path into "video", "audio", "image" or "unknown". */
function classify(path) {
	const ext = extname(path).toLowerCase();
	if (VIDEO_EXTENSIONS.has(ext)) return "video";
	if (AUDIO_EXTENSIONS.has(ext)) return "audio";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	return "unknown";
}

/** Format seconds as a human-readable duration. */
function humanDuration(seconds) {
	if (!Number.isFinite(seconds)) return "unknown";
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
		: `${minutes}:${String(secs).padStart(2, "0")}`;
}

/**
 * Probe a media file into structured facts.
 *
 * @param {string} ffprobe - ffprobe executable.
 * @param {string} path - absolute media path.
 * @param {{signal?: AbortSignal, timeoutMs: number}} options - run options.
 * @returns {Promise<object>} the parsed probe result.
 */
async function probeFile(ffprobe, path, options) {
	const { stdout } = await runCommand(ffprobe, [
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		path
	], { timeoutMs: Math.min(options.timeoutMs, 120000), signal: options.signal });

	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`media: ffprobe returned unparseable output for "${path}". The file may be corrupt or not a media file.`);
	}

	const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
	const video = streams.find((stream) => stream.codec_type === "video");
	const audio = streams.find((stream) => stream.codec_type === "audio");
	const format = parsed.format ?? {};
	const duration = Number(format.duration ?? video?.duration ?? audio?.duration);

	return {
		durationSeconds: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : undefined,
		sizeBytes: Number(format.size ?? 0) || undefined,
		bitrate: Number(format.bit_rate ?? 0) || undefined,
		formatName: format.format_name,
		video: video === undefined ? undefined : {
			codec: video.codec_name,
			width: video.width,
			height: video.height,
			fps: parseFraction(video.avg_frame_rate ?? video.r_frame_rate),
			pixelFormat: video.pix_fmt
		},
		audio: audio === undefined ? undefined : {
			codec: audio.codec_name,
			sampleRate: Number(audio.sample_rate) || undefined,
			channels: audio.channels
		},
		streamCount: streams.length
	};
}

/** Parse ffprobe's "30000/1001" style fraction into a number. */
function parseFraction(value) {
	if (value === undefined || value === "0/0") return undefined;
	const [numerator, denominator] = String(value).split("/").map(Number);
	if (!Number.isFinite(numerator)) return undefined;
	if (denominator === undefined || denominator === 0 || !Number.isFinite(denominator)) return numerator;
	return Math.round((numerator / denominator) * 1000) / 1000;
}

/* ------------------------------------------------------------------- tools */

/** Model-facing text for a probe. */
function formatProbe(value) {
	const lines = [`${value.path}`, `  type: ${value.kind}${value.formatName === undefined ? "" : ` (${value.formatName})`}`];
	if (value.durationSeconds !== undefined) lines.push(`  duration: ${humanDuration(value.durationSeconds)} (${value.durationSeconds}s)`);
	if (value.sizeBytes !== undefined) lines.push(`  size: ${(value.sizeBytes / 1048576).toFixed(2)} MB`);
	if (value.video !== undefined) {
		lines.push(`  video: ${value.video.codec} ${value.video.width}x${value.video.height}${value.video.fps === undefined ? "" : ` @ ${value.video.fps}fps`}`);
	}
	if (value.audio !== undefined) {
		lines.push(`  audio: ${value.audio.codec}${value.audio.sampleRate === undefined ? "" : ` ${value.audio.sampleRate}Hz`}${value.audio.channels === undefined ? "" : ` ${value.audio.channels}ch`}`);
	}
	if (value.video === undefined && value.audio === undefined) lines.push("  no audio or video stream was found");
	return lines.join("\n");
}

/**
 * Register the enabled media tools.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - context whose `tools` registry receives the tools.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 */
function apply(ctx, config) {
	const outputDir = resolve(config.outputDir);
	const budgetMs = config.timeoutMs;
	const ffmpeg = config.ffmpegPath;
	const ffprobe = config.ffprobePath;

	/** Resolve a configured output path and make sure the directory exists. */
	async function outPath(fileName) {
		await mkdir(outputDir, { recursive: true });
		return join(outputDir, fileName);
	}

	/* -- media_status ------------------------------------------------------ */
	if (config.status) {
		ctx.tools.register(defineTool({
			name: "media_status",
			description: "Report whether ffmpeg and ffprobe are runnable from this plugin, with their versions. Check this before a long transcode.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ffmpeg: {
							type: "object",
							required: true,
							additionalProperties: false,
							properties: {
								command: { type: "string", required: true },
								available: { type: "boolean", required: true },
								version: { type: "string" },
								error: { type: "string" }
							}
						},
						ffprobe: {
							type: "object",
							required: true,
							additionalProperties: false,
							properties: {
								command: { type: "string", required: true },
								available: { type: "boolean", required: true },
								version: { type: "string" },
								error: { type: "string" }
							}
						},
						targets: { type: "array", required: true, items: { type: "string" } }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`ffmpeg: ${value.ffmpeg.available ? `AVAILABLE ${value.ffmpeg.version ?? ""}` : `MISSING — ${value.ffmpeg.error ?? "not found"}`}`,
						`ffprobe: ${value.ffprobe.available ? `AVAILABLE ${value.ffprobe.version ?? ""}` : `MISSING — ${value.ffprobe.error ?? "not found"}`}`,
						`Conversion targets: ${value.targets.join(", ")}`
					].join("\n")
				}]
			},
			timeoutMs: 60000,
			isConcurrencySafe: () => true,
			async execute() {
				const [ffmpegResult, ffprobeResult] = await Promise.all([probeBinary(ffmpeg), probeBinary(ffprobe)]);
				return {
					ffmpeg: { command: ffmpeg, ...ffmpegResult },
					ffprobe: { command: ffprobe, ...ffprobeResult },
					targets: Object.keys(TARGETS)
				};
			},
			presentCall: () => ({ card: "generic", title: "ffmpeg availability", kind: "other", rawInput: {} })
		}));
	}

	/* -- media_probe ------------------------------------------------------- */
	if (config.probe) {
		ctx.tools.register(defineTool({
			name: "media_probe",
			description: "Inspect a media file and return its duration, size, resolution, codecs and stream count, so you can plan a conversion instead of guessing.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to the media file." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: { type: "string", required: true },
						kind: { type: "string", required: true },
						formatName: { type: "string" },
						durationSeconds: { type: "number" },
						sizeBytes: { type: "integer" },
						bitrate: { type: "integer" },
						streamCount: { type: "integer", required: true },
						video: {
							type: "object",
							additionalProperties: false,
							properties: {
								codec: { type: "string" },
								width: { type: "integer" },
								height: { type: "integer" },
								fps: { type: "number" },
								pixelFormat: { type: "string" }
							}
						},
						audio: {
							type: "object",
							additionalProperties: false,
							properties: {
								codec: { type: "string" },
								sampleRate: { type: "integer" },
								channels: { type: "integer" }
							}
						}
					}
				},
				render: (_args, value) => [{ type: "text", text: formatProbe(value) }]
			},
			timeoutMs: 120000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const source = await requireFile(args.path);
				const probed = await probeFile(ffprobe, source, { signal: exec.signal, timeoutMs: budgetMs });
				return { path: source, kind: classify(source), ...probed };
			},
			presentCall: (args) => ({ card: "generic", title: `Probe: ${basename(args.path ?? "file")}`, kind: "other", rawInput: args })
		}));
	}

	/* -- media_convert ----------------------------------------------------- */
	if (config.convert) {
		ctx.tools.register(defineTool({
			name: "media_convert",
			description: "Convert a media file to another format, optionally resizing, trimming or re-encoding at a given quality. Use media_probe first to see what you are working with.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to the source file." },
				target: { type: "string", required: true, description: `Output format: ${Object.keys(TARGETS).join(", ")}.` },
				outputName: { type: "string", description: "Output filename. Defaults to the source stem plus the target extension." },
				width: { type: "integer", description: "Scale to this width, keeping the aspect ratio (even numbers only)." },
				start: { type: "string", description: "Trim start, e.g. \"00:00:05\" or \"5\"." },
				duration: { type: "string", description: "Trim length from start, e.g. \"10\" for 10 seconds." },
				crf: { type: "integer", description: "Constant-quality factor for video (lower is better; 18–28 is typical)." },
				removeAudio: { type: "boolean", description: "Drop the audio track entirely." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						source: { type: "string", required: true },
						target: { type: "string", required: true },
						outputPath: { type: "string", required: true },
						sizeBytes: { type: "integer" },
						command: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `Converted to ${value.target}: ${value.outputPath}${value.sizeBytes === undefined ? "" : ` (${(value.sizeBytes / 1048576).toFixed(2)} MB)`}`
				}]
			},
			timeoutMs: budgetMs,
			async execute(args, exec) {
				const source = await requireFile(args.path);
				const preset = TARGETS[args.target];
				if (preset === undefined) {
					throw new Error(`media: unknown target "${args.target}". Choose one of: ${Object.keys(TARGETS).join(", ")}.`);
				}
				if (args.crf !== undefined && (args.crf < 0 || args.crf > 51)) {
					throw new Error(`media: crf must be between 0 and 51 (lower is better quality); got ${args.crf}.`);
				}
				const stem = basename(source, extname(source));
				const outputName = args.outputName ?? `${stem}.${preset.container}`;
				const destination = await outPath(outputName);

				const ffArgs = ["-hide_banner", "-loglevel", "error", "-y"];
				if (args.start !== undefined) ffArgs.push("-ss", String(args.start));
				ffArgs.push("-i", source);
				if (args.duration !== undefined) ffArgs.push("-t", String(args.duration));
				if (preset.vcodec !== null) {
					const filters = [];
					if (args.width !== undefined) {
						if (args.width < 2 || args.width % 2 !== 0) {
							throw new Error(`media: width must be a positive even number (video encoders require it); got ${args.width}.`);
						}
						filters.push(`scale=${args.width}:-2`);
					}
					if (filters.length > 0) ffArgs.push("-vf", filters.join(","));
					ffArgs.push("-c:v", preset.vcodec);
					if (args.crf !== undefined) ffArgs.push("-crf", String(args.crf));
				} else if (args.width !== undefined) {
					throw new Error(`media: target "${args.target}" is audio-only, so width does not apply.`);
				}
				if (preset.acodec !== null && args.removeAudio !== true) {
					ffArgs.push("-c:a", preset.acodec);
				} else {
					ffArgs.push("-an");
				}
				ffArgs.push(...preset.extra, destination);

				await runCommand(ffmpeg, ffArgs, { timeoutMs: budgetMs, signal: exec.signal });
				const info = await stat(destination).catch(() => undefined);
				return {
					source,
					target: args.target,
					outputPath: destination,
					...info === undefined ? {} : { sizeBytes: info.size },
					command: `ffmpeg ${ffArgs.join(" ")}`
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Convert ${basename(args.path ?? "file")} → ${args.target ?? "?"}`, kind: "other", rawInput: args })
		}));
	}

	/* -- media_frames ------------------------------------------------------ */
	if (config.frames) {
		ctx.tools.register(defineTool({
			name: "media_frames",
			description: "Extract still frames from a video as images, either evenly spaced across the clip or at explicit timestamps.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to the video." },
				count: { type: "integer", description: `How many evenly spaced frames to take (1–${config.maxFrames}). Defaults to 6.` },
				timestamps: { type: "string", description: "Explicit comma-separated timestamps (e.g. \"0,5,12.5\"), overriding count." },
				format: { type: "string", description: "Image format: png (default) or jpg." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						source: { type: "string", required: true },
						count: { type: "integer", required: true },
						frames: { type: "array", required: true, items: { type: "string" } }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `Extracted ${value.count} frame(s) from ${value.source}:\n${value.frames.map((frame) => `- ${frame}`).join("\n")}`
				}]
			},
			timeoutMs: budgetMs,
			async execute(args, exec) {
				const source = await requireFile(args.path);
				const kind = classify(source);
				if (kind !== "video") {
					throw new Error(`media: media_frames needs a video, but "${source}" looks like ${kind}. For a still image, just read the file directly.`);
				}
				const imageFormat = args.format ?? "png";
				if (!["png", "jpg", "jpeg"].includes(imageFormat)) {
					throw new Error(`media: format must be png or jpg; got "${imageFormat}".`);
				}
				const extension = imageFormat === "jpeg" ? "jpg" : imageFormat;
				const stem = basename(source, extname(source));
				const probed = await probeFile(ffprobe, source, { signal: exec.signal, timeoutMs: budgetMs });

				let timestamps;
				if (args.timestamps !== undefined && args.timestamps.trim().length > 0) {
					timestamps = args.timestamps.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
					if (timestamps.length > config.maxFrames) {
						throw new Error(`media: ${timestamps.length} timestamps exceeds maxFrames (${config.maxFrames}). Split the request.`);
					}
				} else {
					const count = args.count ?? 6;
					if (count < 1 || count > config.maxFrames) {
						throw new Error(`media: count must be between 1 and ${config.maxFrames}; got ${count}.`);
					}
					if (probed.durationSeconds === undefined) {
						throw new Error("media: cannot space frames evenly because the duration could not be read. Pass explicit timestamps instead.");
					}
					timestamps = Array.from({ length: count }, (_unused, index) =>
						String(Math.round(((index + 0.5) / count) * probed.durationSeconds * 1000) / 1000));
				}

				const frames = [];
				for (const [index, timestamp] of timestamps.entries()) {
					const outputName = `${stem}.frame${String(index + 1).padStart(2, "0")}.${extension}`;
					const destination = await outPath(outputName);
					await runCommand(ffmpeg, [
						"-hide_banner", "-loglevel", "error", "-y",
						"-ss", String(timestamp),
						"-i", source,
						"-frames:v", "1",
						destination
					], { timeoutMs: budgetMs, signal: exec.signal });
					frames.push(destination);
				}
				return { source, count: frames.length, frames };
			},
			presentCall: (args) => ({ card: "generic", title: `Frames from ${basename(args.path ?? "video")}`, kind: "other", rawInput: args })
		}));
	}

	/* -- media_audio ------------------------------------------------------- */
	if (config.audio) {
		ctx.tools.register(defineTool({
			name: "media_audio",
			description: "Pull the audio track out of a video into a standalone audio file, for transcription or listening.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to the source file." },
				target: { type: "string", description: "Audio format: wav, mp3, aac or flac. Defaults to wav (lossless, best for speech-to-text)." },
				sampleRate: { type: "integer", description: "Resample to this rate, e.g. 16000 for speech recognition." },
				channels: { type: "integer", description: "Downmix to this many channels (1 = mono)." },
				outputName: { type: "string", description: "Output filename, overriding the default." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						source: { type: "string", required: true },
						outputPath: { type: "string", required: true },
						sizeBytes: { type: "integer" },
						command: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: `Audio extracted to ${value.outputPath}${value.sizeBytes === undefined ? "" : ` (${(value.sizeBytes / 1048576).toFixed(2)} MB)`}`
				}]
			},
			timeoutMs: budgetMs,
			async execute(args, exec) {
				const source = await requireFile(args.path);
				const audioTarget = args.target ?? "wav";
				const preset = TARGETS[audioTarget];
				if (preset === undefined || preset.vcodec !== null) {
					throw new Error(`media: target must be one of wav, mp3, aac, flac; got "${audioTarget}".`);
				}
				const stem = basename(source, extname(source));
				const destination = await outPath(args.outputName ?? `${stem}.${preset.container}`);

				const ffArgs = ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vn", "-c:a", preset.acodec];
				if (args.sampleRate !== undefined) ffArgs.push("-ar", String(args.sampleRate));
				if (args.channels !== undefined) ffArgs.push("-ac", String(args.channels));
				ffArgs.push(...preset.extra, destination);

				await runCommand(ffmpeg, ffArgs, { timeoutMs: budgetMs, signal: exec.signal });
				const info = await stat(destination).catch(() => undefined);
				return {
					source,
					outputPath: destination,
					...info === undefined ? {} : { sizeBytes: info.size },
					command: `ffmpeg ${ffArgs.join(" ")}`
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Extract audio: ${basename(args.path ?? "file")}`, kind: "other", rawInput: args })
		}));
	}

	/* -- media_compress ---------------------------------------------------- */
	if (config.compress) {
		ctx.tools.register(defineTool({
			name: "media_compress",
			description: "Shrink a video to a target file size in megabytes using two-pass encoding, so the result lands near the budget instead of overshooting it.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to the source video." },
				targetSizeMb: { type: "number", required: true, description: "Desired output size in megabytes, e.g. 10." },
				audioKbps: { type: "integer", description: "Audio bitrate to reserve (default 128 kbps)." },
				width: { type: "integer", description: "Optionally downscale to this width before encoding." },
				outputName: { type: "string", description: "Output filename." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						source: { type: "string", required: true },
						outputPath: { type: "string", required: true },
						targetSizeBytes: { type: "integer", required: true },
						sizeBytes: { type: "integer" },
						videoKbps: { type: "integer", required: true },
						passes: { type: "integer", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`Compressed to ${value.outputPath}`,
						`target: ${(value.targetSizeBytes / 1048576).toFixed(2)} MB | actual: ${value.sizeBytes === undefined ? "unknown" : `${(value.sizeBytes / 1048576).toFixed(2)} MB`}`,
						`video bitrate: ${value.videoKbps} kbps over ${value.passes} passes`
					].join("\n")
				}]
			},
			timeoutMs: budgetMs,
			async execute(args, exec) {
				const source = await requireFile(args.path);
				if (classify(source) !== "video") {
					throw new Error(`media: media_compress needs a video. For audio, use media_audio with a lower bitrate target.`);
				}
				if (!(args.targetSizeMb > 0)) {
					throw new Error(`media: targetSizeMb must be a positive number; got ${args.targetSizeMb}.`);
				}
				if (args.width !== undefined && (args.width < 2 || args.width % 2 !== 0)) {
					throw new Error(`media: width must be a positive even number; got ${args.width}.`);
				}
				const probed = await probeFile(ffprobe, source, { signal: exec.signal, timeoutMs: budgetMs });
				const duration = probed.durationSeconds;
				if (duration === undefined || duration <= 0) {
					throw new Error("media: cannot read the duration, so a bitrate cannot be derived. Probe the file first with media_probe.");
				}
				const audioKbps = args.audioKbps ?? 128;
				const targetBits = args.targetSizeMb * 8 * 1048576;
				const videoKbps = Math.floor((targetBits / duration) / 1000) - audioKbps;
				if (videoKbps < 50) {
					throw new Error(`media: a ${args.targetSizeMb} MB budget over ${humanDuration(duration)} leaves only ${videoKbps} kbps for video, which is too low to be watchable. Raise targetSizeMb or trim the clip first.`);
				}

				const stem = basename(source, extname(source));
				const destination = await outPath(args.outputName ?? `${stem}.compressed.mp4`);
				const passLog = join(outputDir, `${stem}.passlog`);
				const filters = args.width === undefined ? [] : ["-vf", `scale=${args.width}:-2`];
				const common = [
					"-hide_banner", "-loglevel", "error", "-y",
					"-i", source,
					...filters,
					"-c:v", "libx264", "-b:v", `${videoKbps}k`,
					"-c:a", "aac", "-b:a", `${audioKbps}k`
				];

				// Two-pass rate control is what makes a byte budget land on target.
				await runCommand(ffmpeg, [
					...common, "-pass", "1", "-passlogfile", passLog, "-an", "-f", "null", "-"
				], { timeoutMs: budgetMs, signal: exec.signal });
				await runCommand(ffmpeg, [
					...common, "-pass", "2", "-passlogfile", passLog, "-movflags", "+faststart", destination
				], { timeoutMs: budgetMs, signal: exec.signal });

				const info = await stat(destination).catch(() => undefined);
				return {
					source,
					outputPath: destination,
					targetSizeBytes: Math.round(args.targetSizeMb * 1048576),
					...info === undefined ? {} : { sizeBytes: info.size },
					videoKbps,
					passes: 2
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Compress ${basename(args.path ?? "video")} → ${args.targetSizeMb ?? "?"} MB`, kind: "other", rawInput: args })
		}));
	}

	/**
	 * Resolve an input path and assert it is a readable file, with a message the
	 * model can act on.
	 *
	 * @param {string} path - the caller's path argument.
	 * @returns {Promise<string>} the absolute path.
	 */
	async function requireFile(path) {
		const source = resolve(path);
		let info;
		try {
			info = await stat(source);
		} catch {
			throw new Error(`media: no file at "${source}". Pass an absolute path to an existing media file.`);
		}
		if (!info.isFile()) throw new Error(`media: "${source}" is not a file.`);
		return source;
	}
}

export { Config, apply, inject, name };