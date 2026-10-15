import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assessPreflight, GROUPS } from "../../scripts/assess-hosted-preflight.mjs";
const complete = () => ({targetId:"synthetic-target",readAuthorizationRecord:"synthetic-read-approval",
  groups:GROUPS.map(id=>({id,outcome:"GO",evidenceRef:"synthetic-evidence",reviewedBy:"synthetic-reviewer"}))});
describe("saved hosted preflight worksheet (no connections)",()=>{
  it("CLI returns all groups unverified for missing, malformed or null evidence",()=>{
    const dir=mkdtempSync(path.join(tmpdir(),"halo-ws3-assess-"));
    try {
      for(const [name,body] of [["missing",undefined],["malformed","{"],["null","null"]] as const) {
        const file=path.join(dir,name);
        if(body!==undefined) writeFileSync(file,body);
        const result=spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/assess-hosted-preflight.mjs"),file],{encoding:"utf8"});
        expect(result.status).toBe(2);
        const parsed=JSON.parse(result.stdout);
        expect(parsed).toMatchObject({overall:"NOT VERIFIED",preMigration:"NOT VERIFIED",executionAuthorized:false});
        expect(parsed.groups).toHaveLength(10);
        expect(parsed.groups.every((r:{outcome:string})=>r.outcome==="NOT VERIFIED")).toBe(true);
      }
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it("starts every actual T1–T10 group unverified",()=>{
    const result=assessPreflight({});
    expect(result.overall).toBe("NOT VERIFIED");
    expect(result.groups.map(r=>r.id)).toEqual(Array.from({length:10},(_,i)=>`T${i+1}`));
    expect(result.groups.every(r=>r.outcome==="NOT VERIFIED")).toBe(true);
  });
  it("requires target/read authorization, evidence and reviewer even for claimed GO",()=>{
    const input=complete();
    input.groups[0].evidenceRef="";
    expect(assessPreflight(input).overall).toBe("NOT VERIFIED");
    expect(assessPreflight({...complete(),readAuthorizationRecord:""}).overall).toBe("NOT VERIFIED");
    expect(assessPreflight({...complete(),targetId:""}).overall).toBe("NOT VERIFIED");
    const missingReviewer=complete();missingReviewer.groups[4].reviewedBy="";
    expect(assessPreflight(missingReviewer).overall).toBe("NOT VERIFIED");
  });
  it("reports STOP for failures, unexpected groups or duplicates",()=>{
    const input=complete();input.groups[3].outcome="STOP";
    expect(assessPreflight(input).overall).toBe("STOP");
    expect(assessPreflight({...complete(),groups:[...complete().groups,{id:"T11",outcome:"GO"}]}).overall).toBe("STOP");
    expect(assessPreflight({...complete(),groups:[...complete().groups,complete().groups[0]]}).overall).toBe("STOP");
  });
  it("separates prerequisite evidence from post-apply acceptance and never authorizes execution",()=>{
    const input=complete();input.groups[9].outcome="NOT VERIFIED";
    expect(assessPreflight(input)).toMatchObject({overall:"NOT VERIFIED",preMigration:"GO",executionAuthorized:false});
    expect(assessPreflight(complete())).toMatchObject({overall:"GO",preMigration:"GO",executionAuthorized:false});
  });
});
