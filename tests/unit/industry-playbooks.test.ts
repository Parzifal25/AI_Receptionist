import { describe, expect, it } from "vitest";
import {
  INDUSTRY_PLAYBOOKS,
  matchIndustryPlaybook,
} from "@/core/services/industry-playbooks";

describe("matchIndustryPlaybook", () => {
  it("matches common industry phrasings to the right playbook", () => {
    const cases: Array<[industry: string, description: string, expected: string]> = [
      ["Dentistry", "", "dental"],
      ["", "A family dentist office in Austin", "dental"],
      ["HVAC", "", "hvac"],
      ["Heating & Cooling", "", "hvac"],
      ["Plumbing", "", "plumbing"],
      ["", "24/7 emergency plumber", "plumbing"],
      ["Electrical contractor", "", "electrical"],
      ["Roofing", "", "roofing"],
      ["Law Firm", "", "legal"],
      ["", "Personal injury attorney", "legal"],
      ["Med Spa", "", "medspa"],
      ["Hair Salon", "", "salon"],
      ["Medical Clinic", "", "clinic"],
      ["Real Estate", "", "realestate"],
      ["Insurance Agency", "", "insurance"],
      ["Fitness", "A CrossFit gym", "gym"],
      ["Veterinary", "", "veterinary"],
      ["Smart Home", "Home automation installs", "homeautomation"],
    ];
    for (const [industry, description, expected] of cases) {
      expect(matchIndustryPlaybook(industry, description)?.id, `${industry} ${description}`).toBe(
        expected,
      );
    }
  });

  it("returns null for unknown or empty industries", () => {
    expect(matchIndustryPlaybook("", "")).toBeNull();
    expect(matchIndustryPlaybook("Aerospace manufacturing")).toBeNull();
  });

  it("every playbook has qualifying details and notes", () => {
    for (const playbook of INDUSTRY_PLAYBOOKS) {
      expect(playbook.qualifyingDetails.length, playbook.id).toBeGreaterThan(0);
      expect(playbook.notes.length, playbook.id).toBeGreaterThan(0);
    }
  });

  it("regulated industries carry a compliance hard line", () => {
    for (const id of ["dental", "legal", "medspa", "clinic", "insurance", "veterinary"]) {
      const playbook = INDUSTRY_PLAYBOOKS.find((p) => p.id === id);
      expect(playbook?.compliance, id).toBeTruthy();
    }
  });

  it("trade emergencies include life-safety instructions", () => {
    const hvac = matchIndustryPlaybook("HVAC");
    expect(hvac?.emergency).toMatch(/gas/i);
    const electrical = matchIndustryPlaybook("Electrician");
    expect(electrical?.emergency).toMatch(/911/);
  });
});
