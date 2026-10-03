import { Router, type IRouter } from "express";
import healthRouter from "./health";
import videoAnalysisRouter from "./video-analysis";
import videoRouter from "./videos";

const router: IRouter = Router();

router.use(healthRouter);
router.use(videoRouter);
router.use(videoAnalysisRouter);

export default router;
