'use strict';

/**
 * factory_artifacts and factory_events: the factory machine's build history,
 * written by POST /v1/factory/sync. Each row is kept once by id; a resent id
 * is skipped. Artifacts first, because factory_events.artifact_id points at it.
 * CommonJS (.cjs) because sequelize-cli require()s migration files; the rest of
 * the server package is native ESM.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('factory_artifacts', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      kind: { type: Sequelize.TEXT, allowNull: false },
      at: { type: Sequelize.DATE, allowNull: false },
      body: { type: Sequelize.JSONB, allowNull: false },
    });
    await queryInterface.createTable('factory_events', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      run_id: { type: Sequelize.UUID, allowNull: false },
      at: { type: Sequelize.DATE, allowNull: false },
      repo: { type: Sequelize.TEXT, allowNull: false },
      design: { type: Sequelize.TEXT, allowNull: false },
      pr: { type: Sequelize.INTEGER, allowNull: true },
      type: { type: Sequelize.TEXT, allowNull: false },
      details: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      artifact_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'factory_artifacts', key: 'id' },
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('factory_events');
    await queryInterface.dropTable('factory_artifacts');
  },
};
