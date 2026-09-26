// Imports every model, so `mongoose.models` is complete wherever this module
// is imported.
//
// Without it, the boot index check and `admin doctor` see only the models that
// some route happened to load first, and a model nobody imported yet is
// checked by neither — its indexes are never built and the doctor reports a
// clean bill of health for a collection it did not look at. Add every new
// model here.
import mongoose from "mongoose";
import "./Item.js";
import "./Profile.js";

/** Every registered model, sorted by name so the boot log and the doctor
 *  output stay diffable between runs. */
export function allModels(): mongoose.Model<unknown>[] {
  return Object.values(mongoose.models)
    .map((model) => model as mongoose.Model<unknown>)
    .sort((a, b) => a.modelName.localeCompare(b.modelName));
}
