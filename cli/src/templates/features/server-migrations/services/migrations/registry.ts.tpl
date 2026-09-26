// Every migration this build knows, in order.
//
// APPEND ONLY. Never edit, reorder, renumber or delete a released migration:
// databases out there have its id recorded, and changing what id 4 means makes
// "4 is applied" a lie on every one of them. A mistake in a released migration
// is fixed by appending the correction as the next id.
import { baseline } from "./001-baseline.js";
import type { Migration } from "./types.js";

export const MIGRATIONS: readonly Migration[] = [baseline];

/**
 * The newest schema this build understands: the id of its last migration.
 * A database whose applied migrations require a reader newer than this is
 * refused at boot, before the lock and before any write.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.at(-1)?.id ?? 0;

/**
 * Throws when the list is not 1…n in order, or a migration claims a reader
 * newer than itself. Run by the test suite and once by the runner, so a bad
 * append fails in CI instead of halfway through a production boot.
 */
export function assertMigrationSequence(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.id !== index + 1) {
      throw new Error(
        `migration at position ${index + 1} has id ${migration.id}; ids must be 1, 2, 3 … in order`,
      );
    }
    if (
      !Number.isInteger(migration.minReaderSchema) ||
      migration.minReaderSchema < 0 ||
      migration.minReaderSchema > migration.id
    ) {
      throw new Error(
        `migration ${migration.id} has minReaderSchema ${migration.minReaderSchema}; ` +
          "it must be an integer from 0 to its own id",
      );
    }
  });
}
