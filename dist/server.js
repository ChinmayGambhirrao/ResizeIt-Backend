import express, {} from "express";
import multer from "multer";
import sharp, {} from "sharp";
import archiver from "archiver";
import cors from "cors";
import rateLimit from "express-rate-limit";
const app = express();
// CORS - allow your Vercel domain and local development
const allowedOrigins = [
    "http://localhost:5173", // Vite dev server
    "http://localhost:3000", // Alternative dev port
    "https://resize-it-3xqk.vercel.app/" // Your actual Vercel domain
];
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin)
            return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        else {
            return callback(new Error('Not allowed by CORS'));
        }
    },
    exposedHeaders: ["Content-Disposition", "Content-Length", "Content-Type"],
}));
app.use(express.json());
// Multer - memory storage, 25MB limit
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});
// Public health route
app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
});
// Rate limiting
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use("/resize", limiter);
// Simple per-IP concurrency guard (2 concurrent requests per IP)
const ipActiveCount = new Map();
function concurrencyGuard(req, res, next) {
    const xff = req.headers["x-forwarded-for"];
    const xffFirst = (Array.isArray(xff) ? xff[0] : xff);
    const xffStr = xffFirst ?? "";
    const firstPart = xffStr.split(",")[0] || "";
    const ipHeader = firstPart.trim();
    const reqIp = typeof req.ip === "string" ? req.ip : "";
    const ip = ipHeader || reqIp;
    const current = ipActiveCount.get(ip) ?? 0;
    if (current >= 2) {
        return res.status(429).send("Too many concurrent requests");
    }
    ipActiveCount.set(ip, current + 1);
    res.on("finish", () => {
        const after = ipActiveCount.get(ip) ?? 1;
        const nextVal = Math.max(0, after - 1);
        ipActiveCount.set(ip, nextVal);
    });
    next();
}
function isValidFormat(fmt) {
    return fmt === "png" || fmt === "jpeg" || fmt === "webp";
}
function clampDimension(value) {
    const n = typeof value === "string" ? parseInt(value, 10) : typeof value === "number" ? value : NaN;
    if (!Number.isFinite(n))
        return null;
    if (n <= 0)
        return null;
    if (n > 8000)
        return 8000; // cap to max
    return Math.floor(n);
}
app.post("/resize", concurrencyGuard, upload.single("logo"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send("No file uploaded");
        }
        // Validate MIME type (accept image/* except HEIC/HEIF)
        const mime = req.file.mimetype || "";
        if (!mime.startsWith("image/")) {
            return res.status(400).send("Unsupported file type");
        }
        if (mime.includes("heic") || mime.includes("heif")) {
            return res.status(400).send("HEIC/HEIF not supported");
        }
        // Parse options
        const maintainAspect = String(req.body.maintainAspect ?? "true") === "true";
        const fitBody = String(req.body.fit || "cover");
        const fit = (fitBody === "contain" ? "contain" : "cover");
        // Optional quality overrides
        const jpegQuality = clampDimension(req.body.jpegQuality) ?? 85;
        const webpQuality = clampDimension(req.body.webpQuality) ?? 80;
        // Outputs: Prefer JSON array in field "outputs".
        // Also support single-output shortcut via width/height/format fields.
        let outputs = [];
        const rawOutputs = req.body.outputs;
        if (rawOutputs !== undefined) {
            try {
                outputs = Array.isArray(rawOutputs) ? rawOutputs : JSON.parse(rawOutputs);
            }
            catch {
                return res.status(400).send("Invalid outputs payload");
            }
        }
        else {
            const wAlt = clampDimension(req.body.width);
            const hAlt = clampDimension(req.body.height);
            const fAltRaw = String(req.body.format || "").toLowerCase();
            if (wAlt && hAlt && isValidFormat(fAltRaw)) {
                outputs = [{ width: wAlt, height: hAlt, format: fAltRaw }];
            }
        }
        if (!Array.isArray(outputs) || outputs.length === 0) {
            return res.status(400).send("At least one output is required");
        }
        // Validate outputs
        const normalized = [];
        for (const out of outputs) {
            const w = clampDimension(out.width);
            const h = clampDimension(out.height);
            const f = String(out.format || "").toLowerCase();
            if (!w || !h || !isValidFormat(f)) {
                return res.status(400).send("Each output must include valid width, height, and format");
            }
            normalized.push({ width: w, height: h, format: f });
        }
        // De-duplicate outputs (same width/height/format)
        const uniqueKey = (s) => `${s.width}x${s.height}.${s.format}`;
        const uniqueMap = new Map();
        for (const spec of normalized) {
            uniqueMap.set(uniqueKey(spec), spec);
        }
        const unique = Array.from(uniqueMap.values());
        // Force single download if requested via flag
        const forceSingle = String(req.body.single ?? req.body.forceSingle ?? "false") === "true";
        // Inspect source to enforce dimension constraints and autorotate
        const source = sharp(req.file.buffer, { failOn: "none" }).rotate();
        const meta = await source.metadata();
        if (!meta || (!meta.width && !meta.height)) {
            return res.status(400).send("Unable to read image metadata");
        }
        const baseName = (req.file.originalname || "image").replace(/\.[^.]+$/, "");
        // Helper to build a pipeline per output
        async function renderOne(spec) {
            let pipeline = source.clone();
            // Resize behavior
            if (maintainAspect) {
                pipeline = pipeline.resize({
                    width: spec.width,
                    height: spec.height,
                    fit,
                });
            }
            else {
                // exact stretch
                pipeline = pipeline.resize({ width: spec.width, height: spec.height, fit: "fill" });
            }
            // Format-specific handling
            let contentType = "image/png";
            if (spec.format === "png") {
                pipeline = pipeline.png({ compressionLevel: 9, force: true });
                contentType = "image/png";
            }
            else if (spec.format === "jpeg") {
                // Replace alpha with white for JPEG
                pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({
                    quality: jpegQuality,
                    progressive: true,
                    chromaSubsampling: "4:2:0",
                    force: true,
                });
                contentType = "image/jpeg";
            }
            else if (spec.format === "webp") {
                pipeline = pipeline.webp({ quality: webpQuality, force: true });
                contentType = "image/webp";
            }
            const buffer = await pipeline.toBuffer();
            if (!buffer || buffer.length === 0) {
                throw new Error("Empty image buffer after processing");
            }
            // Filename
            const name = `${baseName}_${spec.width}x${spec.height}.${spec.format}`;
            return { name, buffer, contentType };
        }
        // Always return single image when forceSingle is true, regardless of output count
        if (forceSingle) {
            const only = unique[0];
            const out = await renderOne(only);
            res.status(200);
            res.setHeader("Content-Type", out.contentType);
            res.setHeader("Content-Disposition", `attachment; filename=${out.name}`);
            res.setHeader("Content-Length", String(out.buffer.length));
            return res.send(out.buffer);
        }
        // For multiple outputs without forceSingle, return ZIP
        if (unique.length === 1) {
            const only = unique[0];
            const out = await renderOne(only);
            res.status(200);
            res.setHeader("Content-Type", out.contentType);
            res.setHeader("Content-Disposition", `attachment; filename=${out.name}`);
            res.setHeader("Content-Length", String(out.buffer.length));
            return res.send(out.buffer);
        }
        // Multiple outputs → ZIP
        res.status(200);
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename=${baseName}_resized.zip`);
        const archive = archiver("zip", { zlib: { level: 9 } });
        archive.on("error", (err) => {
            console.error(err);
            if (!res.headersSent)
                res.status(500);
            res.end("Archive error");
        });
        archive.pipe(res);
        for (const spec of unique) {
            const out = await renderOne(spec);
            archive.append(out.buffer, { name: out.name });
        }
        await archive.finalize();
    }
    catch (error) {
        console.error(error);
        if (!res.headersSent) {
            res.status(500).send("Something went wrong.");
        }
        else {
            res.end();
        }
    }
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on ${PORT}`));
//# sourceMappingURL=server.js.map