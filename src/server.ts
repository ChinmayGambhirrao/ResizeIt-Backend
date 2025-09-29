import express, {type NextFunction, type Request, type Response} from "express";
import multer from "multer";
import sharp, {type FitEnum} from "sharp";
import archiver from "archiver";
import cors from "cors";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";

const app = express();

// CORS - allow local Vite during dev
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// Multer - memory storage, 25MB limit
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});

// Public health route
app.get("/health", (_req: Request, res: Response) => {
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
const ipActiveCount: Map<string, number> = new Map();
function concurrencyGuard(req: Request, res: Response, next: NextFunction) {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip;
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

// JWT auth middleware for /resize
function requireJwt(req: Request, res: Response, next: NextFunction) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        return res.status(500).send("Server misconfigured: missing JWT_SECRET");
    }
    if (!token) {
        return res.status(401).send("Missing bearer token");
    }
    try {
        jwt.verify(token, secret);
        return next();
    } catch {
        return res.status(401).send("Invalid token");
    }
}

type OutputFormat = "png" | "jpeg" | "webp";
interface ResizeOutputSpec {
    width: number;
    height: number;
    format: OutputFormat;
}

function isValidFormat(fmt: string): fmt is OutputFormat {
    return fmt === "png" || fmt === "jpeg" || fmt === "webp";
}

function clampDimension(value: unknown): number | null {
    const n = typeof value === "string" ? parseInt(value, 10) : typeof value === "number" ? value : NaN;
    if (!Number.isFinite(n)) return null;
    if (n <= 0) return null;
    if (n > 8000) return 8000; // cap to max
    return Math.floor(n);
}

app.post(
    "/resize",
    requireJwt,
    concurrencyGuard,
    upload.single("logo"),
    async (req: Request, res: Response) => {
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
            const fit: keyof FitEnum = (fitBody === "contain" ? "contain" : "cover");

            // Optional quality overrides
            const jpegQuality = clampDimension(req.body.jpegQuality) ?? 85;
            const webpQuality = clampDimension(req.body.webpQuality) ?? 80;

            // Outputs: JSON array passed in body as string field "outputs"
            let outputs: ResizeOutputSpec[] = [];
            try {
                const raw = req.body.outputs;
                outputs = Array.isArray(raw) ? raw : JSON.parse(raw);
            } catch {
                return res.status(400).send("Invalid outputs payload");
            }
            if (!Array.isArray(outputs) || outputs.length === 0) {
                return res.status(400).send("At least one output is required");
            }

            // Validate outputs
            const normalized: ResizeOutputSpec[] = [];
            for (const out of outputs) {
                const w = clampDimension((out as any).width);
                const h = clampDimension((out as any).height);
                const f = String((out as any).format || "").toLowerCase();
                if (!w || !h || !isValidFormat(f)) {
                    return res.status(400).send("Each output must include valid width, height, and format");
                }
                normalized.push({ width: w, height: h, format: f as OutputFormat });
            }

            // Inspect source to enforce dimension constraints and autorotate
            const source = sharp(req.file.buffer, { failOn: "none" }).rotate();
            const meta = await source.metadata();
            if (!meta || (!meta.width && !meta.height)) {
                return res.status(400).send("Unable to read image metadata");
            }

            // Helper to build a pipeline per output
            async function renderOne(spec: ResizeOutputSpec): Promise<{ name: string; buffer: Buffer; contentType: string }>
            {
                let pipeline = source.clone();

                // Resize behavior
                if (maintainAspect) {
                    pipeline = pipeline.resize({
                        width: spec.width,
                        height: spec.height,
                        fit,
                    });
                } else {
                    // exact stretch
                    pipeline = pipeline.resize({ width: spec.width, height: spec.height, fit: "fill" });
                }

                // Format-specific handling
                let contentType = "image/png";
                if (spec.format === "png") {
                    pipeline = pipeline.png({ compressionLevel: 9 });
                    contentType = "image/png";
                } else if (spec.format === "jpeg") {
                    // Replace alpha with white for JPEG
                    pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({
                        quality: jpegQuality,
                        progressive: true,
                        chromaSubsampling: "4:2:0",
                    });
                    contentType = "image/jpeg";
                } else if (spec.format === "webp") {
                    pipeline = pipeline.webp({ quality: webpQuality });
                    contentType = "image/webp";
                }

                const buffer = await pipeline.toBuffer();

                // Filename
                const base = (req.file.originalname || "image").replace(/\.[^.]+$/, "");
                const name = `${base}_${spec.width}x${spec.height}.${spec.format}`;
                return { name, buffer, contentType };
            }

            if (normalized.length === 1) {
                const out = await renderOne(normalized[0]);
                res.setHeader("Content-Type", out.contentType);
                res.setHeader("Content-Disposition", `attachment; filename=${out.name}`);
                return res.end(out.buffer);
            }

            // Multiple outputs → ZIP
            res.status(200);
            res.setHeader("Content-Type", "application/zip");
            const base = (req.file.originalname || "image").replace(/\.[^.]+$/, "");
            res.setHeader("Content-Disposition", `attachment; filename=${base}_resized.zip`);

            const archive = archiver("zip", { zlib: { level: 9 } });
            archive.on("error", (err) => {
                console.error(err);
                if (!res.headersSent) res.status(500);
                res.end("Archive error");
            });
            archive.pipe(res);

            for (const spec of normalized) {
                const out = await renderOne(spec);
                archive.append(out.buffer, { name: out.name });
            }

            await archive.finalize();
        } catch (error) {
            console.error(error);
            if (!res.headersSent) {
                res.status(500).send("Something went wrong.");
            } else {
                res.end();
            }
        }
    }
);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on ${PORT}`));