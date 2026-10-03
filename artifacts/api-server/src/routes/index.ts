import { Router, type IRouter } from "express";
import healthRouter from "./health";
import videoAnalysisRouter from "./video-analysis";
import videoRouter from "./videos";
import reelRouter from "./reels";
import apiKeyAuth from "../middlewares/api-key-auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(apiKeyAuth);
router.use(videoRouter);
router.use(videoAnalysisRouter);
router.use(reelRouter);

export default router;
