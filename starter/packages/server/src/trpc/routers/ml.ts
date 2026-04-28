import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import {
  bgRemovalInputSchema,
  subtitleInputSchema,
  imageRecognitionInputSchema,
  model3dInputSchema,
  samObjectsInputSchema,
  samBodyInputSchema,
  hunyuan3dInputSchema,
  trellis3dInputSchema,
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

  generate3dSamObjects: protectedProcedure
    .input(samObjectsInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await mlService.generate3dSamObjects(input.imageBase64, input.removeBg);
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "SAM 3D Objects generation failed",
        });
      }
    }),

  generate3dSamBody: protectedProcedure
    .input(samBodyInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await mlService.generate3dSamBody(input.imageBase64);
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "SAM 3D Body generation failed",
        });
      }
    }),

  generate3dHunyuan: protectedProcedure
    .input(hunyuan3dInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await mlService.generate3dHunyuan(
          input.imageBase64,
          input.removeBg,
          input.withTexture,
        );
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Hunyuan3D generation failed",
        });
      }
    }),

  generate3dTrellis: protectedProcedure
    .input(trellis3dInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await mlService.generate3dTrellis(input.imageBase64, input.removeBg);
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "TRELLIS 2 generation failed",
        });
      }
    }),
});
