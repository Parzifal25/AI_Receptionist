# HALO — Multi-Tenant AI Employee Platform
## Architecture & Implementation Blueprint

**Version:** 0.1  
**Purpose:** Independent AI voice/employee platform that can operate standalone and later integrate deeply with OpsCorp FSM.  
**Initial vertical:** Solar lead qualification for Arunodhaya Solar Systems.  
**Primary language for first demo:** Telugu, with Telugu-English code switching.

---

# 1. Executive Architecture

HALO should be built as a **multi-tenant AI employee platform**.

Each business/customer gets one or more **logical agents** configured for that business. The underlying HALO runtime, telephony layer, tool framework, workflow engine, observability, and infrastructure are shared.

The important distinction is:

```text
                    HALO PLATFORM
                         |
        +----------------+----------------+
        |                |                |
        v                v                v
   Arunodhaya        Business B       Business C
      Tenant            Tenant           Tenant
        |                |                |
        v                v                v
  Solar Agent       Sales Agent       Support Agent
        |                |                |
        +----------------+----------------+
                         |
                         v
                  SHARED HALO CORE
```

Do **not** create a separate codebase or separate AI runtime for every customer.

Instead:

```text
Tenant
  -> Agent Configuration
      -> Knowledge
      -> Tools
      -> Workflows
      -> Voice
      -> Policies
      -> Business Rules
```

while the execution engine remains shared.

---

# 2. Core Product Concept

HALO is not fundamentally a phone bot.

It is an:

> **AI employee execution platform.**

Voice is one interface.

The long-term model is:

```text
                 HALO
                  |
        +---------+---------+
        |         |         |
      Voice     Chat     Messaging
        |         |         |
        +---------+---------+
                  |
             Agent Runtime
                  |
        +---------+---------+
        |         |         |
       Tools   Workflows  Knowledge
        |         |         |
        +---------+---------+
                  |
             Business Systems
        +---------+---------+
        |         |         |
       CRM      Calendar    FSM
```

---

# 3. Multi-Tenant Model

Every business using HALO is a **tenant**.

Example:

```text
HALO
|
+-- Tenant: Arunodhaya Solar Systems
|    |
|    +-- Agent: Telugu Solar Telecaller
|    +-- Agent: Follow-up Agent
|    +-- Agent: Appointment Agent
|
+-- Tenant: Company B
|    |
|    +-- Agent: Sales Agent
|
+-- Tenant: Company C
     |
     +-- Agent: Customer Support Agent
```

## Important

A tenant must never be able to access another tenant's:

- leads
- calls
- recordings
- transcripts
- knowledge
- tools
- credentials
- agent configuration
- analytics
- customer data

Tenant isolation is a first-class architectural concern.

---

# 4. Agent Architecture

An agent is primarily **configuration + capabilities**, not a separate program.

Conceptually:

```text
Agent
|
+-- Identity
|    +-- Name
|    +-- Company
|    +-- Role
|    +-- Personality
|
+-- Objective
|    +-- Primary goal
|    +-- Success criteria
|
+-- Conversation Policy
|    +-- Opening
|    +-- Qualification
|    +-- Objection handling
|    +-- Escalation
|    +-- Closing
|
+-- Knowledge
|    +-- Company information
|    +-- Products
|    +-- Pricing
|    +-- FAQs
|    +-- Policies
|
+-- Tools
|    +-- CRM
|    +-- Calendar
|    +-- WhatsApp
|    +-- Custom APIs
|
+-- Workflow
|    +-- Lead qualification
|    +-- Follow-up
|    +-- Appointment
|
+-- Voice
|    +-- Language
|    +-- Voice provider
|    +-- Voice
|
+-- Guardrails
     +-- Allowed actions
     +-- Restricted claims
     +-- Escalation rules
```

This lets the same runtime execute many different agents.

---

# 5. Example: Arunodhaya Agent

The first real HALO agent could be:

```text
Tenant:
Arunodhaya Solar Systems

Agent:
Arunodhaya Telugu Solar Telecaller

Role:
AI telecaller

Primary objective:
Qualify inbound solar leads and schedule qualified prospects.

Language:
Telugu + Telugu-English code switching

Tools:
- get_lead
- update_lead
- schedule_callback
- schedule_site_visit
- send_confirmation
- end_call
```

The runtime itself does not contain Arunodhaya-specific hardcoded logic.

Instead:

```text
HALO Runtime
      |
      +--> Arunodhaya Agent Configuration
      |
      +--> Arunodhaya Knowledge
      |
      +--> Arunodhaya Tools
```

---

# 6. High-Level System Architecture

```text
                                  INTERNET
                                     |
             +-----------------------+-----------------------+
             |                       |                       |
             v                       v                       v
         Web App                 API Clients             Webhooks
             |                       |                       |
             +-----------------------+-----------------------+
                                     |
                                     v
                         +-----------------------+
                         |     API Gateway       |
                         | Auth / Rate Limits   |
                         +-----------+-----------+
                                     |
             +-----------------------+-----------------------+
             |                       |                       |
             v                       v                       v
      Agent Service            Lead Service          Call Service
             |                       |                       |
             +-----------------------+-----------------------+
                                     |
                                     v
                         +-----------------------+
                         |   HALO Orchestrator   |
                         +-----------+-----------+
                                     |
          +--------------------------+--------------------------+
          |                          |                          |
          v                          v                          v
   Agent Runtime               Tool Runtime             Workflow Engine
          |                          |                          |
          |                          |                          |
          +--------------------------+--------------------------+
                                     |
                                     v
                         +-----------------------+
                         |   Voice Runtime       |
                         +-----------+-----------+
                                     |
                     +---------------+---------------+
                     |               |               |
                     v               v               v
                   STT             LLM              TTS
                     |               |               |
                     +---------------+---------------+
                                     |
                                     v
                              Telephony Provider
                                     |
                                     v
                                   PSTN
                                     |
                                     v
                                CUSTOMER
```

---

# 7. Request / Call Lifecycle

## Outbound call

```text
Lead enters HALO
      |
      v
Lead Service
      |
      v
Call Scheduler
      |
      v
Call Service
      |
      v
Telephony Provider
      |
      v
Customer answers
      |
      v
Audio Stream
      |
      v
STT
      |
      v
Conversation Manager
      |
      v
Agent Runtime
      |
      +-----> Knowledge Retrieval
      |
      +-----> Tool Decision
      |
      +-----> Workflow State
      |
      v
LLM
      |
      v
Response
      |
      v
TTS
      |
      v
Audio Stream
      |
      v
Customer
```

---

# 8. Real-Time Voice Loop

The voice loop is the most latency-sensitive component.

```text
CUSTOMER SPEECH
      |
      v
Audio Input
      |
      v
Voice Activity Detection
      |
      v
Streaming STT
      |
      v
Partial / Final Transcript
      |
      v
Conversation State
      |
      v
Agent Runtime
      |
      +--> Does this require a tool?
      |          |
      |          +--> YES --> Tool Runtime
      |          |
      |          +--> NO
      |
      v
LLM Response
      |
      v
Streaming TTS
      |
      v
Audio Output
      |
      v
CUSTOMER
```

The runtime should support interruption:

```text
HALO speaking
     |
Customer starts speaking
     |
     v
Detect interruption
     |
     v
Stop / reduce TTS playback
     |
     v
Process customer speech
```

---

# 9. Agent Runtime

The Agent Runtime is the core of HALO.

It should be provider-agnostic.

```text
Agent Runtime
|
+-- Context Builder
|
+-- Conversation State
|
+-- Policy Engine
|
+-- Prompt Composer
|
+-- Knowledge Resolver
|
+-- Tool Selector
|
+-- LLM Adapter
|
+-- Response Validator
|
+-- Memory Manager
|
+-- Workflow State Manager
|
+-- Escalation Manager
```

## Important design principle

Do not send the entire tenant configuration to the LLM on every turn.

Use a layered context model:

```text
STATIC
  |
  +-- Agent identity
  +-- Core rules
  +-- Safety rules

DYNAMIC
  |
  +-- Current customer
  +-- Current lead
  +-- Current workflow
  +-- Recent conversation

RETRIEVED
  |
  +-- Relevant knowledge
  +-- Relevant business policy

TOOLS
  |
  +-- Only tools available for this workflow
```

This keeps token usage and latency under control.

---

# 10. Context Architecture

A conversation should have a context budget.

```text
System / Policy Context
        |
        +-- Small and stable
        |
Agent Context
        |
        +-- Role
        +-- Objective
        +-- Rules
        |
Customer Context
        |
        +-- Name
        +-- Lead data
        +-- Relevant history
        |
Conversation Context
        |
        +-- Recent turns
        |
Retrieved Context
        |
        +-- Only relevant knowledge
        |
Tool Context
        |
        +-- Only required tools
```

Avoid repeatedly injecting:

- entire CRM records
- entire knowledge bases
- entire transcripts
- unrelated tools
- redundant instructions

---

# 11. Tool Architecture

Tools are the bridge between conversation and real-world action.

```text
Agent
  |
  v
Tool Registry
  |
  +-- CRM Tools
  +-- Calendar Tools
  +-- Messaging Tools
  +-- HALO Tools
  +-- Tenant Custom Tools
  +-- OpsCorp Tools
```

Each tool should have:

```text
Tool
|
+-- Name
+-- Description
+-- Input Schema
+-- Output Schema
+-- Authorization Policy
+-- Execution Handler
+-- Timeout
+-- Retry Policy
```

Example:

```text
schedule_site_visit

Input:
{
  lead_id,
  preferred_date,
  preferred_time
}

Output:
{
  appointment_id,
  confirmed,
  scheduled_time
}
```

---

# 12. Tool Execution

```text
LLM
 |
 | tool_call
 v
Tool Runtime
 |
 +--> Validate schema
 |
 +--> Check tenant
 |
 +--> Check authorization
 |
 +--> Execute
 |
 +--> Log action
 |
 +--> Return structured result
 |
 v
Agent Runtime
 |
 v
LLM / Conversation
```

The LLM must never directly execute arbitrary code.

---

# 13. Business Adapter Layer

This is critical for future OpsCorp integration.

HALO should expose generic interfaces.

```text
HALO
 |
 +-- Lead Interface
 +-- Customer Interface
 +-- Appointment Interface
 +-- Messaging Interface
 +-- Service Interface
```

Each external system gets an adapter.

```text
                 HALO Tool Interface
                         |
             +-----------+-----------+
             |                       |
             v                       v
       Arunodhaya Adapter       OpsCorp Adapter
             |                       |
             v                       v
      Arunodhaya CRM            OpsCorp API
```

For example:

```text
HALO Tool:
create_service_request()

        |
        v

OpsCorp Adapter:
createServiceRequest()

        |
        v

OpsCorp FSM API
```

HALO should not know the internal implementation of OpsCorp.

---

# 14. OpsCorp Integration

Eventually:

```text
                    HALO
                     |
               Tool Interface
                     |
              OpsCorp Adapter
                     |
                     v
                OpsCorp FSM
                     |
        +------------+------------+
        |            |            |
        v            v            v
     Customer       Jobs      Technicians
        |            |            |
        +------------+------------+
                     |
                     v
                 Scheduling
```

Example conversation:

```text
Customer:
"My AC isn't working."

HALO:
Understands issue

HALO:
get_customer()

HALO:
get_active_service_contract()

HALO:
create_service_request()

HALO:
get_available_slots()

HALO:
schedule_job()

HALO:
send_confirmation()

HALO:
Update conversation outcome
```

This is where HALO becomes the AI employee layer of OpsCorp.

---

# 15. Knowledge Architecture

HALO should support tenant-specific knowledge.

```text
Tenant Knowledge
|
+-- Company
+-- Products
+-- Pricing
+-- FAQs
+-- Policies
+-- Scripts
+-- Technical documentation
+-- Objection handling
```

Recommended initial architecture:

```text
Document
   |
   v
Ingestion
   |
   +-- Parse
   +-- Chunk
   +-- Metadata
   +-- Embeddings
   |
   v
Knowledge Store
   |
   v
Retriever
   |
   v
Relevant Context
   |
   v
Agent Runtime
```

Do not introduce a vector database just because it is an AI project. PostgreSQL + pgvector is sufficient for the early platform unless scale or retrieval requirements justify a separate system.

---

# 16. Knowledge Guardrails

The agent should distinguish:

```text
KNOWN
  |
  +-- Approved business information

UNKNOWN
  |
  +-- Do not invent

RESTRICTED
  |
  +-- Must escalate / refuse

ACTION
  |
  +-- Must use a tool
```

Example:

```text
Customer:
"How much subsidy will I get?"

HALO
  |
  +--> retrieve approved subsidy information
  |
  +--> answer
```

If information is unavailable:

```text
HALO:
"I don't want to give you incorrect information.
I can arrange for our solar specialist to confirm that."
```

---

# 17. Workflow Engine

Conversation and workflow should be separate concepts.

Example:

```text
Solar Lead Qualification
|
+-- Lead Created
|
+-- Call Lead
|
+-- Connected?
|      |
|      +-- NO --> Retry
|      |
|      +-- YES
|
+-- Qualification
|
+-- Interested?
|      |
|      +-- NO --> Close
|      |
|      +-- YES
|
+-- Qualified?
|      |
|      +-- NO --> Nurture
|      |
|      +-- YES
|
+-- Schedule Appointment
|
+-- Confirmation
|
+-- Sales Handoff
```

The agent handles the conversation.

The workflow engine controls the business process.

This distinction becomes very important at scale.

---

# 18. Call State Machine

A call should have explicit states.

```text
CREATED
   |
   v
QUEUED
   |
   v
DIALING
   |
   +------> FAILED
   |
   v
RINGING
   |
   +------> NO_ANSWER
   |
   v
CONNECTED
   |
   v
IN_CONVERSATION
   |
   +------> TRANSFERRED
   |
   +------> INTERRUPTED
   |
   v
COMPLETING
   |
   v
COMPLETED
```

Call outcomes should be separate from technical call states.

Example:

```text
Call State:
COMPLETED

Business Outcome:
QUALIFIED
```

---

# 19. Lead Qualification

Qualification should be structured, not just an LLM-generated paragraph.

```text
Lead
|
+-- Contact
+-- Location
+-- Property Type
+-- Electricity Bill
+-- Existing Solar
+-- Desired Capacity
+-- Purchase Timeline
+-- Interest Level
+-- Qualification Score
+-- Appointment
+-- Outcome
```

Example:

```json
{
  "status": "qualified",
  "score": 88,
  "monthly_bill": 8000,
  "property_type": "residential",
  "location": "Hyderabad",
  "timeline": "1-3_months",
  "appointment_requested": true
}
```

Structured fields should be stored independently of the transcript.

---

# 20. Call Recording and Transcript

```text
Telephony
    |
    +--> Audio Recording
    |
    +--> Call Metadata
    |
    +--> Transcript
             |
             +--> Speaker turns
             +--> Timestamps
             +--> Language
             +--> Tool events
             +--> Outcome
```

Storage:

```text
Object Storage
    |
    +-- recordings/
    +-- exports/
```

Database stores metadata and references, not large audio blobs.

---

# 21. Analytics

The analytics layer should eventually measure:

```text
Calls
|
+-- Total
+-- Connected
+-- Failed
+-- Duration
+-- Cost
|
+-- Outcomes
|    +-- Qualified
|    +-- Interested
|    +-- Not Interested
|    +-- Callback
|
+-- Conversion
|    +-- Appointment rate
|    +-- Qualified rate
|    +-- Sales handoff rate
|
+-- AI quality
     +-- Interruptions
     +-- Escalations
     +-- Tool failures
     +-- Unknown questions
```

Business analytics should be separated from raw call telemetry.

---

# 22. Data Architecture

Recommended early database:

```text
PostgreSQL
|
+-- tenants
+-- users
+-- agents
+-- agent_versions
+-- agent_knowledge
+-- tools
+-- workflows
+-- leads
+-- customers
+-- calls
+-- conversations
+-- messages
+-- tool_executions
+-- appointments
+-- call_outcomes
+-- analytics_events
+-- integrations
+-- phone_numbers
+-- audit_logs
```

Potential later additions:

```text
billing
usage
campaigns
webhook_deliveries
knowledge_documents
knowledge_chunks
agent_memory
```

---

# 23. Agent Versioning

Never mutate a production agent configuration without versioning.

```text
Agent
 |
 +-- Version 1
 +-- Version 2
 +-- Version 3
```

A call should record:

```text
agent_id
agent_version_id
```

This allows you to answer:

> "Which agent configuration produced this call?"

and compare versions.

This is essential for debugging and evaluation.

---

# 24. Security Architecture

Minimum requirements:

```text
Authentication
      |
      v
Authorization
      |
      v
Tenant Isolation
      |
      v
Tool Authorization
      |
      v
Audit Logging
```

Sensitive areas:

- phone numbers
- recordings
- transcripts
- CRM credentials
- API keys
- customer data

Never expose provider credentials to the frontend.

Use encrypted secret storage where possible.

---

# 25. External Integrations

HALO should use an integration abstraction.

```text
Integrations
|
+-- Telephony
|    +-- Exotel
|    +-- Future providers
|
+-- LLM
|    +-- Provider A
|    +-- Provider B
|
+-- STT
|    +-- Provider A
|    +-- Provider B
|
+-- TTS
|    +-- Provider A
|    +-- Provider B
|
+-- Messaging
|    +-- WhatsApp
|
+-- Calendar
|    +-- Google Calendar
|
+-- CRM
|    +-- Customer-specific
|
+-- FSM
     +-- OpsCorp
```

Provider-specific code should stay behind adapters.

---

# 26. Provider Abstraction

Avoid:

```text
Agent Runtime
     |
     +--> hardcoded Exotel API
     +--> hardcoded provider X
```

Prefer:

```text
Agent Runtime
     |
     v
Telephony Interface
     |
     +--> Exotel Adapter
     +--> Provider B Adapter
```

Same principle for:

```text
LLM
STT
TTS
Calendar
Messaging
CRM
```

This protects HALO from vendor lock-in.

---

# 27. Recommended Initial Technology Stack

## Frontend

```text
Next.js
TypeScript
Tailwind CSS
```

## Backend

```text
Python
FastAPI
Pydantic
```

## Database

```text
PostgreSQL
pgvector when needed
```

## Realtime

```text
WebSockets
Async Python
Redis where required
```

## Infrastructure

```text
Docker
Cloud deployment
Object storage
Managed PostgreSQL
```

## Observability

```text
Structured logs
Sentry
Metrics
Call telemetry
```

Keep infrastructure simple for v0.x.

Do not introduce Kubernetes, Kafka, or microservices unless actual scale requires them.

---

# 28. Initial Repository Structure

Recommended monorepo:

```text
halo/
|
+-- apps/
|   |
|   +-- web/
|   |    +-- Next.js dashboard
|   |
|   +-- api/
|        +-- FastAPI application
|
+-- packages/
|   |
|   +-- agent-runtime/
|   +-- voice-runtime/
|   +-- tool-runtime/
|   +-- workflow-engine/
|   +-- knowledge/
|   +-- integrations/
|   +-- schemas/
|
+-- providers/
|   |
|   +-- telephony/
|   +-- stt/
|   +-- tts/
|   +-- llm/
|
+-- tenants/
|   |
|   +-- arunodaya/
|        +-- knowledge/
|        +-- agent/
|        +-- tools/
|        +-- workflows/
|
+-- infrastructure/
|   +-- docker/
|   +-- deployment/
|
+-- docs/
|   +-- ARCHITECTURE.md
|   +-- API.md
|   +-- DATABASE.md
|   +-- AGENTS.md
|
+-- tests/
```

The exact repository layout can evolve, but the conceptual separation should remain.

---

# 29. Arunodhaya MVP Architecture

For the first customer, intentionally keep the architecture small.

```text
                    ARUNODHAYA
                         |
                       Leads
                         |
                         v
                  +-------------+
                  |    HALO     |
                  |             |
                  | Solar Agent |
                  +------+------+
                         |
                 Agent Runtime
                         |
          +--------------+--------------+
          |              |              |
          v              v              v
         STT            LLM            TTS
          |              |              |
          +--------------+--------------+
                         |
                    Telephony
                         |
                         v
                    Customer
```

After the call:

```text
Call
 |
 +--> Transcript
 +--> Recording
 +--> Structured Qualification
 +--> Summary
 +--> Outcome
 +--> Appointment
```

Dashboard:

```text
Dashboard
 |
 +-- Calls
 +-- Leads
 +-- Lead Detail
 +-- Agent
 +-- Analytics
```

---

# 30. Arunodhaya Agent Knowledge

The first knowledge package should contain only verified information.

```text
arunodaya/
|
+-- company.md
+-- products.md
+-- solar-systems.md
+-- pricing.md
+-- subsidy.md
+-- installation.md
+-- warranty.md
+-- financing.md
+-- service-area.md
+-- faq.md
+-- objections.md
+-- qualification.md
```

Do not let the agent improvise pricing, subsidy figures, warranties, or installation promises.

---

# 31. Telugu-First Voice Requirements

The Arunodhaya agent should be evaluated on:

```text
Telugu
Telugu + English
Indian accent variation
Numbers
Names
Addresses
Electricity bill amounts
Solar capacity
Interruptions
Silence
Background noise
Fast speech
Corrections
```

Example:

```text
Customer:
"నెలకి ఎనిమిది వేల వరకు బిల్ వస్తుంది."

Expected extraction:
monthly_bill = 8000
```

Code switching:

```text
Customer:
"5 kilowatt system కావాలి."

Expected extraction:
system_capacity = 5kW
```

The language layer should not be tightly coupled to the business logic.

---

# 32. Human Handoff

HALO should never be forced to answer everything.

```text
Conversation
     |
     v
Can HALO safely handle this?
     |
  +--+--+
  |     |
 YES    NO
  |     |
  v     v
Answer  Escalate
        |
        +--> Human transfer
        +--> Callback
        +--> Create task
```

Triggers can include:

- customer requests a human
- unknown technical question
- sensitive issue
- pricing outside configured rules
- complaint
- high-value lead
- low confidence

---

# 33. Reliability

The voice system needs graceful failure.

Examples:

```text
STT failure
   -> retry / clarification

LLM timeout
   -> fallback response

TTS failure
   -> retry / end gracefully

Tool failure
   -> do not pretend it succeeded

Telephony disconnect
   -> mark call state correctly

Database failure
   -> preserve critical event if possible
```

Never tell a customer:

> "Your appointment is booked."

unless the appointment tool actually confirms it.

---

# 34. Cost Architecture

Track usage from day one.

```text
Tenant
 |
 +-- Calls
 |    +-- Telephony minutes
 |    +-- STT usage
 |    +-- LLM tokens
 |    +-- TTS usage
 |
 +-- Storage
 |
 +-- Tool/API usage
```

Each call should have a usage record.

Example:

```text
Call
 |
 +-- duration
 +-- input audio
 +-- output audio
 +-- STT usage
 +-- LLM input tokens
 +-- LLM output tokens
 +-- TTS usage
 +-- estimated cost
```

This becomes important when HALO is sold commercially.

---

# 35. Token-Efficiency Architecture

HALO should explicitly optimize LLM context.

## Do

```text
Current task
+
Relevant customer context
+
Relevant knowledge
+
Relevant tools
+
Recent conversation
```

## Avoid

```text
Entire company documentation
+
Entire customer history
+
All tools
+
Entire transcript
+
Repeated instructions
```

Use:

```text
summarization
retrieval
structured state
tool schemas
short-lived context
```

rather than enormous prompts.

Agent configuration should be stored once and assembled into the minimum runtime context required for each interaction.

---

# 36. Development Workflow With Claude Code + Codex

Recommended role separation:

```text
                 YOU
                  |
          Product / Architecture
                  |
                  v
           Claude Code
             BUILDER
                  |
                  v
               HALO
                  |
                  v
              Codex
          REVIEW / DEBUG
                  |
                  v
           Claude Code
             FIX / TEST
```

Claude Code should be the primary implementation agent.

Codex should primarily:

- review architecture
- identify bugs
- inspect security issues
- inspect race conditions
- review realtime behavior
- review unnecessary complexity
- fix high-confidence problems
- run tests

Do not have both agents independently invent architecture.

---

# 37. Agent Documentation for Coding Agents

Keep persistent project context in:

```text
AGENTS.md
ARCHITECTURE.md
PRODUCT_SPEC.md
API.md
DATABASE.md
DEVELOPMENT.md
```

`AGENTS.md` should contain concise engineering rules.

Example:

```text
HALO is multi-tenant.
HALO is independent of OpsCorp.
Business-specific behavior belongs in tenant configuration/adapters.
Provider integrations must be replaceable.
Use structured tools for actions.
Never fabricate business information.
Minimize LLM context.
Prefer simple architecture.
Run tests before completion.
```

This prevents repeated long prompts and reduces coding-agent token usage.

---

# 38. Deployment Evolution

## v0.x

```text
Single cloud environment
|
+-- Web
+-- API
+-- Worker
+-- PostgreSQL
+-- Redis
+-- Object Storage
```

## v1.x

```text
Load Balancer
      |
+-----+-----+
|           |
API       Workers
|           |
+-----+-----+
      |
 PostgreSQL
      |
 Redis
```

## Scale

Only when justified:

```text
API
Call Workers
Workflow Workers
Analytics Workers
Knowledge Workers
```

Do not prematurely split everything into microservices.

---

# 39. Product Evolution

## HALO v0.1

Arunodhaya Telugu solar telecaller.

```text
Outbound
+
Telugu
+
Qualification
+
Appointment
+
Transcript
+
Recording
```

## HALO v0.2

```text
Follow-ups
Retry scheduling
WhatsApp
Better analytics
```

## HALO v0.3

```text
Inbound calls
Multiple agents
Campaigns
CRM integrations
```

## HALO v0.4

```text
Generic integrations
Tenant management
Billing
Usage
Agent versioning
```

## HALO + OpsCorp

```text
Customer
   |
   v
HALO
   |
   v
OpsCorp
   |
   +-- Customer
   +-- Job
   +-- Technician
   +-- Schedule
   +-- Asset
   +-- Contract
   +-- Payment
```

---

# 40. Long-Term HALO + OpsCorp Architecture

```text
                         HALO
                          |
             +------------+------------+
             |            |            |
           Voice        Chat       WhatsApp
             |            |            |
             +------------+------------+
                          |
                   Agent Runtime
                          |
        +-----------------+-----------------+
        |                 |                 |
    Knowledge          Tools            Workflows
        |                 |                 |
        +-----------------+-----------------+
                          |
                 Integration Layer
                          |
             +------------+------------+
             |                         |
             v                         v
        External SaaS             OpsCorp FSM
                                       |
              +------------------------+-----------------------+
              |            |            |            |          |
              v            v            v            v          v
          Customers      Jobs      Technicians   Assets    Scheduling
```

This is the strategic architecture.

HALO becomes the **AI interaction and execution layer**.

OpsCorp remains the **operational system of record for field service**.

---

# 41. Critical Architectural Principles

## Principle 1 — HALO is independent

HALO must work without OpsCorp.

## Principle 2 — Customers get agents, not codebases

Each business gets configuration and isolated data.

## Principle 3 — Runtime is shared

The same runtime executes thousands of agents.

## Principle 4 — Tools execute actions

The LLM decides; deterministic tools perform actions.

## Principle 5 — Workflows control business processes

Conversation should not become the entire business logic.

## Principle 6 — Providers are replaceable

Telephony, STT, TTS and LLM providers should be adapters.

## Principle 7 — Knowledge is controlled

The agent should never invent business facts.

## Principle 8 — Tenant isolation is mandatory

Every request and data access is tenant-scoped.

## Principle 9 — Optimize context

Send only the context required for the current task.

## Principle 10 — Build simple first

The architecture should support scale without requiring scale on day one.

---

# 42. The Core Mental Model

The simplest way to understand HALO is:

```text
              BUSINESS
                  |
          Agent Configuration
                  |
        +---------+---------+
        |         |         |
   Knowledge    Tools    Workflows
        |         |         |
        +---------+---------+
                  |
             Agent Runtime
                  |
          +-------+-------+
          |       |       |
         Voice   Chat   Messaging
          |       |       |
          +-------+-------+
                  |
            REAL WORLD
```

And for OpsCorp:

```text
Customer
   |
   v
HALO
   |
   | "Understand + Decide + Act"
   |
   v
OpsCorp FSM
   |
   | "System of Record + Operations"
   |
   v
Technician / Customer / Business
```

---

# 43. Final Architectural Decision

The recommended model is:

> **One HALO platform → many tenants → many specialized agents → one shared agent runtime → configurable tools/workflows/knowledge → external system adapters.**

Therefore, for every future business that needs HALO:

```text
NEW BUSINESS
     |
     v
CREATE TENANT
     |
     v
CREATE AGENT
     |
     +--> Configure role
     +--> Configure objective
     +--> Configure language
     +--> Add knowledge
     +--> Add tools
     +--> Define workflow
     +--> Connect business systems
     |
     v
DEPLOY AGENT
```

You are **not rebuilding HALO** for every business.

You are creating a new **AI employee instance** on the same HALO platform.

That is the foundation that lets Arunodhaya be the first customer while keeping HALO architecturally independent and ready for future OpsCorp integration.
