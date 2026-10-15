import { describe, it, expect, vi } from "vitest";
import { telemetryId, jobTelemetryId, withTelemetryContext } from "@halo/platform/telemetry";
import { CampaignEngine, type ClaimedContact, type CampaignStore } from "@halo/campaigns/engine";
import { ReminderService } from "@halo/scheduling/reminder-service";
import { DEFAULT_SCHEDULING_SETTINGS } from "@halo/core/domain/scheduling";
import type { SchedulingRepository } from "@halo/scheduling/scheduling-repository";
import type { MessagingProvider } from "@halo/ports/messaging-provider";
import { WorkflowEngine } from "@halo/workflows/engine";
import { InMemoryWorkflowStore } from "../mocks/in-memory-workflow-store";
const a="11111111-1111-4111-8111-111111111111", b="22222222-2222-4222-8222-222222222222";
describe("scheduled-item context",()=>{
 it("uses tenant-scoped stable context for concurrent campaign jobs and settlement after timeout",async()=>{
  const seen: Array<[string,string|undefined]>=[];
  const run=async(tenant:string)=>{
   const contact:ClaimedContact={id:"same-job",businessId:tenant,campaignId:"campaign",customerId:"customer",agentId:"agent",agentVersionId:"version",from:"synthetic",to:"synthetic",attempt:1};
   const store:CampaignStore={claim:async()=>[contact],authorize:async()=>true,settle:async()=>{seen.push([tenant,telemetryId()]);}};
   const dialer={dial:vi.fn(async()=>{await Promise.resolve();seen.push([tenant,telemetryId()]);throw new Error("synthetic-private-token");})};
   expect((await new CampaignEngine(store,dialer).dispatch(tenant,"campaign")).uncertain).toBe(1);
   expect(dialer.dial).toHaveBeenCalledTimes(1);
  };
  await Promise.all([run(a),run(b)]);
  for(const [tenant,id] of seen) expect(id).toBe(jobTelemetryId("campaign_contact",tenant,"same-job"));
  expect(jobTelemetryId("campaign_contact",a,"same-job")).not.toBe(jobTelemetryId("campaign_contact",b,"same-job"));
  expect(telemetryId()).toBeUndefined();
 });
 it("preserves reminder identity across deliveries/retries without raw provider errors",async()=>{
  const seen:Array<string|undefined>=[], errors:string[]=[];
  const repo={claimDueReminders:async()=>[{id:7,businessId:a,appointmentId:"appt",channel:"sms",attempts:1}],getAppointment:async()=>({id:"appt",businessId:a,status:"confirmed",startsAt:"2031-01-01T10:00:00Z",endsAt:"2031-01-01T11:00:00Z",visitorPhone:"synthetic",visitorEmail:"",manageToken:"synthetic"}),getSettings:async()=>DEFAULT_SCHEDULING_SETTINGS,recordReminderError:async(_id:number,error:string)=>{seen.push(telemetryId());errors.push(error);},requeueReminder:async()=>{throw new Error("must_not_requeue_ambiguous_send");},trackEvent:async()=>{},markReminderSent:async()=>{}} as unknown as SchedulingRepository;
  const messaging={supports:()=>true,send:async()=>{seen.push(telemetryId());throw new Error("synthetic-private-token");}} as unknown as MessagingProvider;
  const service=new ReminderService(repo,messaging,"http://synthetic.test");
  for(const cron of [a,b]) await withTelemetryContext(()=>service.processDue(1,new Date("2031-01-01T08:00:00Z")),cron);
  expect(seen).toEqual(Array(4).fill(jobTelemetryId("reminder",a,"7")));expect(errors).toEqual(["delivery_outcome_unknown","delivery_outcome_unknown"]);
  expect(telemetryId()).toBeUndefined();
 });
 it("restores serialized timer context before emitting its next event",async()=>{
  const store=new InMemoryWorkflowStore();
  await store.scheduleTimer(JSON.parse(JSON.stringify({businessId:a,eventType:"lead.created",payload:{token:"synthetic-private"},correlationId:"journey",telemetryCorrelationId:a,fireAt:"2000-01-01T00:00:00Z"})));
  const seen:Array<string|undefined>=[];
  await withTelemetryContext(()=>new WorkflowEngine(store,{}).processDue({emit:async()=>{seen.push(telemetryId());}}),b);
  expect(seen).toEqual([a]);expect(telemetryId()).toBeUndefined();
 });
});
