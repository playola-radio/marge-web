"use strict";

/**
 * The PR reviewer's tables: one row per generation of one PR revision (the run,
 * which is also the runner's job), a content-addressed cache of LLM stage
 * outputs, the assembled reading document, the run's changed markdown files,
 * and per-user reviewed marks. The three run children cascade on run delete.
 * CommonJS (.cjs) because sequelize-cli require()s migration files; the rest of
 * the server package is native ESM.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const timestamp = { type: Sequelize.DATE, allowNull: false };
    const runId = {
      type: Sequelize.UUID,
      allowNull: false,
      references: { model: "pr_reviewer_runs", key: "id" },
      onDelete: "CASCADE",
    };

    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "pr_reviewer_runs",
        {
          id: {
            type: Sequelize.UUID,
            primaryKey: true,
            allowNull: false,
            defaultValue: Sequelize.literal("gen_random_uuid()"),
          },
          org: { type: Sequelize.TEXT, allowNull: false },
          repo: { type: Sequelize.TEXT, allowNull: false },
          pr_number: { type: Sequelize.INTEGER, allowNull: false },
          head_sha: { type: Sequelize.TEXT, allowNull: false },
          base_sha: { type: Sequelize.TEXT, allowNull: false },
          pipeline_version: { type: Sequelize.TEXT, allowNull: false },
          status: { type: Sequelize.TEXT, allowNull: false },
          progress: { type: Sequelize.JSONB, allowNull: true },
          failure: { type: Sequelize.TEXT, allowNull: true },
          failure_detail: { type: Sequelize.TEXT, allowNull: true },
          lease_expires_at: { type: Sequelize.DATE, allowNull: true },
          lease_token: { type: Sequelize.UUID, allowNull: true },
          attempt: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          pr_meta: { type: Sequelize.JSONB, allowNull: false },
          created_at: timestamp,
          updated_at: timestamp,
        },
        { transaction },
      );
      await queryInterface.addIndex(
        "pr_reviewer_runs",
        [
          "org",
          "repo",
          "pr_number",
          "head_sha",
          "base_sha",
          "pipeline_version",
        ],
        {
          name: "pr_reviewer_runs_revision_unique",
          unique: true,
          transaction,
        },
      );
      await queryInterface.addIndex(
        "pr_reviewer_runs",
        ["status", "lease_expires_at"],
        { name: "pr_reviewer_runs_status_lease", transaction },
      );

      await queryInterface.createTable(
        "pr_reviewer_stage_outputs",
        {
          cache_key: {
            type: Sequelize.CHAR(64),
            primaryKey: true,
            allowNull: false,
          },
          stage: { type: Sequelize.TEXT, allowNull: false },
          output: { type: Sequelize.JSONB, allowNull: false },
          created_at: timestamp,
        },
        { transaction },
      );

      await queryInterface.createTable(
        "pr_reviewer_documents",
        {
          run_id: { ...runId, primaryKey: true },
          document: { type: Sequelize.JSONB, allowNull: false },
          created_at: timestamp,
        },
        { transaction },
      );

      await queryInterface.createTable(
        "pr_reviewer_run_files",
        {
          run_id: { ...runId, primaryKey: true },
          path: { type: Sequelize.TEXT, primaryKey: true, allowNull: false },
          text: { type: Sequelize.TEXT, allowNull: false },
          created_at: timestamp,
        },
        { transaction },
      );

      await queryInterface.createTable(
        "pr_reviewer_chapter_reviews",
        {
          run_id: { ...runId, primaryKey: true },
          chapter_key: {
            type: Sequelize.TEXT,
            primaryKey: true,
            allowNull: false,
          },
          user_email: {
            type: Sequelize.TEXT,
            primaryKey: true,
            allowNull: false,
          },
          created_at: timestamp,
        },
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("pr_reviewer_chapter_reviews", {
        transaction,
      });
      await queryInterface.dropTable("pr_reviewer_run_files", { transaction });
      await queryInterface.dropTable("pr_reviewer_documents", { transaction });
      await queryInterface.dropTable("pr_reviewer_stage_outputs", {
        transaction,
      });
      await queryInterface.dropTable("pr_reviewer_runs", { transaction });
    });
  },
};
