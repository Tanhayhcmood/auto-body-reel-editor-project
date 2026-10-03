import { Router, type IRouter } from "express";
import healthRouter from "./health";
import videoAnalysisRouter from "./video-analysis";
import videoRouter from "./videos";
import telegramRouter from "./telegram";
import apiKeyAuth from "../middlewares/api-key-auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(telegramRouter);
router.use(apiKeyAuth);
router.use(videoRouter);
router.use(videoAnalysisRouter);

export default router;
