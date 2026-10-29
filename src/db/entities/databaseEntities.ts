import { EntitySchema, getMetadataArgsStorage } from 'typeorm';
import type { EntitySchemaColumnOptions } from 'typeorm';
import entities, { VectorEmbedding } from './index.js';

/**
 * Derive SQLite schemas from the same decorators without mutating global metadata.
 * PostgreSQL keeps its existing schema (especially timestamp columns during upgrades).
 * Binding each schema to the original class keeps all repository targets unchanged.
 */
export function getDatabaseEntities(type: 'postgres' | 'better-sqlite3') {
  if (type === 'postgres') {
    return entities;
  }

  const metadata = getMetadataArgsStorage();
  return entities
    .filter((entity) => entity !== VectorEmbedding)
    .map((entity) => {
      const table = metadata.tables.find((entry) => entry.target === entity);
      const columns: Record<string, EntitySchemaColumnOptions> = {};
      for (const column of metadata.columns.filter((entry) => entry.target === entity)) {
        const generation = metadata.generations.find(
          (entry) => entry.target === entity && entry.propertyName === column.propertyName,
        );
        const columnType = column.options.type;
        if (!columnType) {
          throw new Error(`Missing explicit column type for ${entity.name}.${column.propertyName}`);
        }
        const options = column.options;
        columns[column.propertyName] = {
          type: columnType === 'timestamp' ? 'datetime' : columnType,
          name: options.name,
          length: options.length,
          primary: options.primary,
          nullable: options.nullable,
          unique: options.unique,
          default: options.default,
          select: options.select,
          insert: options.insert,
          update: options.update,
          transformer: options.transformer,
          createDate: column.mode === 'createDate',
          updateDate: column.mode === 'updateDate',
          ...(generation ? { generated: generation.strategy } : {}),
        };
      }

      return new EntitySchema({
        name: entity.name,
        target: entity,
        tableName: table?.name,
        columns,
        indices: metadata.indices
          .filter((entry) => entry.target === entity)
          .map((entry) => ({
            name: entry.name,
            columns: entry.columns,
            unique: entry.unique,
            where: entry.where,
            synchronize: entry.synchronize,
          })),
      });
    });
}
