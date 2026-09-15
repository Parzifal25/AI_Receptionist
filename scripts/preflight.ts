import { validateProductionReadiness } from "../src/lib/startup-check";

/**
 * Production preflight gate. Fails (exit 1) when required configuration is
 * missing or broken so a deploy cannot proceed silently.
 *
 * The database connectivity probe is a hard error locally and in production.
 * Pass --skip-db-check to downgrade it to a warning — for CI environments
 * where no database is provisioned. The probe itself is never silently
 * skipped: the report always says so.
 */
async function main() {
  const skipDbCheck = process.argv.includes("--skip-db-check");

  console.log("🚀 Starting Production Preflight Check...\n");

  const report = await validateProductionReadiness({ skipDatabaseCheck: skipDbCheck });

  console.log("=== Providers Configuration ===");
  console.log(`Email Provider:    ${report.providers.email ? "✅ Configured" : "❌ Not Configured"}`);
  console.log(`WhatsApp Provider: ${report.providers.whatsapp ? "✅ Configured" : "❌ Not Configured"}`);
  console.log("");

  let hasCriticalErrors = false;

  if (report.warnings.length > 0) {
    console.log("=== Warnings ===");
    report.warnings.forEach((w) => console.log(`⚠️  ${w}`));
    console.log("");
  }

  if (report.errors.length > 0) {
    console.log("=== Errors ===");
    report.errors.forEach((e) => console.log(`❌ ${e}`));
    console.log("");
    hasCriticalErrors = true;
  }

  if (hasCriticalErrors) {
    console.error("💥 Preflight check failed. Please resolve the errors above before deploying.");
    process.exit(1);
  }

  console.log("✅ All checks passed. Ready for production.");
}

main().catch((err) => {
  console.error("Unhandled error during preflight check:", err);
  process.exit(1);
});
