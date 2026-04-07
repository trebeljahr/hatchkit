import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import {
  bgRemovalInputSchema,
  subtitleInputSchema,
  imageRecognitionInputSchema,
  model3dInputSchema,
} from "@starter/shared";
import * as mlService from "../../services/ml.js";

export const mlRouter = router({
  removeBackground: protectedProcedure
    .input(bgRemovalInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await mlService.removeBackground(input.imageBase64, input.model);
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Background removal failed",
        });
      }
    }),

  generateSubtitles: protectedProcedure
    .input(subtitleInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await mlService.generateSubtitles(
          input.audioBase64,
          input.language,
          input.model,
          input.format,
        );
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Subtitle generation failed",
        });
      }
    }),

  recognizeImage: protectedProcedure
    .input(imageRecognitionInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await mlService.recognizeImage(
          input.imageBase64,
          input.labels,
          input.topK,
        );
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Image recognition failed",
        });
      }
    }),

  generate3d: protectedProcedure
    .input(model3dInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await mlService.generate3dModel(
          input.imageBase64,
          input.removeBg,
          input.resolution,
        );
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "3D model generation failed",
        });
      }
    }),
});
