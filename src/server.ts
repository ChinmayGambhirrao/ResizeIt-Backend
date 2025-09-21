import express, {type Request, type Response} from "express";
import multer from "multer"; // using this for uploading files
import sharp from "sharp"; // conversion to jpeg, png etc
import archiver from "archiver";
import path from "path";
import fs from "fs";
import cors from "cors";

const app = express();
const upload = multer({dest: "uploads/"});

app.use(cors());
app.use(express.json());

app.post("/resize", upload.single("logo"), async(req: Request, res: Response) => {
    try {
        const {width, height} = req.body;
    
    if(!req.file) {
        return res.status(400).send("No file uploaded");
    }
    if(!width || !height) {
        return res.status(400).send("Width and height are required");
    }

    const parsedWidth = parseInt(width, 10);
    const parsedHeight = parseInt(height, 10);

    if(isNaN(parsedWidth) || isNaN(parsedHeight)) {
        return res.status(400).send("Width and height must be numbers");
    }

    // Process with sharp
    const resizedBuffer = await sharp(req.file.path).resize(parsedWidth, parsedHeight, {fit: "contain", background: {r: 0, g: 0, b: 0, alpha: 0}}).toFormat("png").toBuffer();

    // cleanup uploaded file
    fs.unlinkSync(req.file.path);

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename=logo_${parsedWidth}x${parsedHeight}.png`);
    res.send(resizedBuffer);

}catch (error) {
    console.error(error);
    res.status(500).send("Something went wrong.");
}
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on ${PORT}`));