import express, {type Request, type Response} from "express";
import multer from "multer";
import sharp from "sharp";
import archiver from "archiver";
import cors from "cors";

const app = express();
app.use(cors());

const upload = multer({storage: multer.memoryStorage()});

const presetSizes = [64, 128, 256, 512];

app.post("/resize", upload.single("logo"), async(req: Request, res: Response) => {
    if(!req.file) {
        return res.status(400).send("No file uploaded");
    }

    res.attachment("resized_logos.zip");
    const archive = archiver("zip", {zlib: {level: 9}});
    archive.pipe(res);

    for (const size of presetSizes) {
        const buffer = await sharp(req.file.buffer).resize(size, size, {fit: "inside",
         background: {r: 0, g: 0, b: 0, alpha: 0}
        }).png().toBuffer();

        archive.append(buffer, {name: `logo_${size}x${size}.png`});
    }

    await archive.finalize();
})

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on ${PORT}`));