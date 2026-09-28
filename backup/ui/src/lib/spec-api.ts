/**
 * Spec API — stub layer for Spec Generation and Spec Execution.
 *
 * Both modes return the SAME structured response format:
 *   { trace_id, request_id, answer, plan, subtask_results }
 *
 * - Spec Generation → answer is the spec document; subtask_results has
 *   the proposed folder/file structure WITHOUT code content.
 * - Spec Execution  → answer is a summary; subtask_results has full
 *   folders + files WITH code content ready to write to workspace.
 *
 * When real APIs become available:
 *   1. Set NEXT_PUBLIC_SPEC_API_URL in .env.local
 *   2. Add rewrite in next.config.ts
 *   3. Replace stub function bodies with authFetch() calls
 *   4. Function signatures and return types stay identical
 */

import { uuid } from "@/lib/uuid";

// import { authFetch } from "@/lib/auth";
// const BASE = process.env.NEXT_PUBLIC_SPEC_API_URL ?? "http://localhost:8003";
// const API = `${BASE}/api/v1/spec`;

/* ── Context files sent alongside the prompt ─────────────────────────── */

export interface SpecContextFile {
  path: string;
  content: string;
  language: string;
}

export interface SpecProjectContext {
  projectId: number;
  projectName: string;
  selectedStoryIds: number[];
  selectedDocIds: number[];
}

/* ── Unified response types (same for both modes) ────────────────────── */

export interface SpecFileEntry {
  path: string;
  language: string;
  purpose: string;
  content: string;
  bytes: number;
  valid: boolean;
  error: string | null;
}

export interface SpecSubtaskOutput {
  project_name: string;
  summary: string;
  folders: string[];
  files: SpecFileEntry[];
}

export interface SpecSubtaskResult {
  id: number;
  description: string;
  success: boolean;
  output: SpecSubtaskOutput;
}

export interface SpecPlan {
  reasoning: string;
  execution_mode: string;
  subtasks: Array<{
    id: number;
    description: string;
    suggested_tools: string[];
    depends_on: number[];
  }>;
}

export interface SpecResponse {
  trace_id: string;
  request_id: string;
  answer: string;
  plan: SpecPlan;
  subtask_results: SpecSubtaskResult[];
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Spec Generation (no agent) ──────────────────────────────────────── *
 * Returns the spec document as `answer`, a plan with steps, and          *
 * subtask_results with the proposed file structure (no code content).     *
 * ──────────────────────────────────────────────────────────────────────── */

export async function specGenerate(
  prompt: string,
  contextFiles: SpecContextFile[] = [],
  projectContext?: SpecProjectContext | null,
): Promise<SpecResponse> {
  // ── STUB: replace with real API call when available ──
  // const res = await authFetch(`${API}/generate`, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({ prompt, context_files: contextFiles, project_context: projectContext }),
  // });
  // if (!res.ok) throw new Error(await res.text());
  // return res.json();

  await delay(1500);

  return {
    trace_id: `trace-${uuid().slice(0, 12)}`,
    request_id: `req-${uuid().slice(0, 10)}`,
    answer: `## Specification Document

### Overview
Based on your request: *"${prompt}"*

### Requirements
1. **Functional Requirements**
   - User authentication and authorization
   - CRUD operations for core entities
   - RESTful API endpoints with proper error handling

2. **Non-Functional Requirements**
   - Response time < 200ms for API calls
   - Support for 1000+ concurrent users
   - 99.9% uptime SLA

### Architecture
- **Backend:** Python / FastAPI with SQLAlchemy ORM
- **Frontend:** React with TypeScript
- **Database:** PostgreSQL
- **Authentication:** JWT-based token auth

### API Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST   | /api/auth/register | User registration |
| POST   | /api/auth/login | User login |
| GET    | /api/resources | List resources |
| POST   | /api/resources | Create resource |
| PUT    | /api/resources/:id | Update resource |
| DELETE | /api/resources/:id | Delete resource |

### Data Models
- **User** — id, email, password_hash, full_name, created_at, is_active
- **Resource** — id, title, description, owner_id, status, created_at, updated_at

### Next Steps
Once this spec is approved, switch to **Spec Exec** mode and select an agent to generate the implementation code.`,
    plan: {
      reasoning:
        "Analyzed the user prompt and identified core requirements for a full-stack application with auth, CRUD, and REST API. Proposing a standard Python/React stack.",
      execution_mode: "sequential",
      subtasks: [
        {
          id: 1,
          description: "Define project structure and folder layout",
          suggested_tools: ["project_scaffolder"],
          depends_on: [],
        },
        {
          id: 2,
          description: "Design database models and schemas",
          suggested_tools: ["code_generator"],
          depends_on: [1],
        },
        {
          id: 3,
          description: "Create API route handlers with validation",
          suggested_tools: ["code_generator"],
          depends_on: [2],
        },
        {
          id: 4,
          description: "Build frontend components and pages",
          suggested_tools: ["code_generator"],
          depends_on: [3],
        },
      ],
    },
    subtask_results: [
      {
        id: 1,
        description: "Proposed project structure (spec only — no code generated yet)",
        success: true,
        output: {
          project_name: "my-app",
          summary: "Proposed folder structure and file layout for the application.",
          folders: [
            "backend",
            "backend/models",
            "backend/routes",
            "backend/services",
            "backend/utils",
            "frontend",
            "frontend/src",
            "frontend/src/components",
            "frontend/src/pages",
          ],
          files: [
            {
              path: "backend/app.py",
              language: "python",
              purpose: "FastAPI entry point — application setup, middleware, router registration",
              content: "",
              bytes: 0,
              valid: true,
              error: null,
            },
            {
              path: "backend/models/user.py",
              language: "python",
              purpose: "SQLAlchemy User model — id, email, password_hash, full_name, timestamps",
              content: "",
              bytes: 0,
              valid: true,
              error: null,
            },
            {
              path: "backend/models/resource.py",
              language: "python",
              purpose: "SQLAlchemy Resource model — id, title, description, owner_id, status",
              content: "",
              bytes: 0,
              valid: true,
              error: null,
            },
            {
              path: "backend/routes/auth_routes.py",
              language: "python",
              purpose: "Auth endpoints — POST /register, POST /login with JWT token generation",
              content: "",
              bytes: 0,
              valid: true,
              error: null,
            },
            {
              path: "backend/routes/resource_routes.py",
              language: "python",
              purpose: "Resource CRUD endpoints — GET, POST, PUT, DELETE with auth guards",
              content: "",
              bytes: 0,
              valid: true,
              error: null,
            },
            {
              path: "backend/services/auth_service.py",
              language: "python",
              purpose: "Authentication business logic — password hashing, JWT generation, validation",
              content: "",
              bytes: 0,
              valid: true,
              error: null,
            },
            {
              path: "backend/utils/validators.py",
              language: "python",
              purpose: "Input validation utilities — email, password, request body validation",
              content: "",
              bytes: 0,
              valid: true,
              error: null,
            },
            {
              path: "backend/requirements.txt",
              language: "plaintext",
              purpose: "Python dependencies — fastapi, uvicorn, sqlalchemy, pyjwt, bcrypt",
              content: "",
              bytes: 0,
              valid: true,
              error: null,
            },
            {
              path: "frontend/src/App.tsx",
              language: "typescript",
              purpose: "React root component — routing, auth provider, theme setup",
              content: "",
              bytes: 0,
              valid: true,
              error: null,
            },
            {
              path: "frontend/src/pages/Login.tsx",
              language: "typescript",
              purpose: "Login page — email/password form, JWT token storage",
              content: "",
              bytes: 0,
              valid: true,
              error: null,
            },
            {
              path: "frontend/package.json",
              language: "json",
              purpose: "Frontend dependencies — react, react-router-dom, axios",
              content: "",
              bytes: 0,
              valid: true,
              error: null,
            },
          ],
        },
      },
    ],
  };
}

/* ── Spec Execution (agent required) ─────────────────────────────────── *
 * Returns a summary as `answer`, a plan, and subtask_results with full   *
 * folders + files INCLUDING code content ready for workspace write.      *
 * ──────────────────────────────────────────────────────────────────────── */

export async function specExecute(
  prompt: string,
  agentId: string,
  contextFiles: SpecContextFile[] = [],
  projectContext?: SpecProjectContext | null,
): Promise<SpecResponse> {
  // ── STUB: replace with real API call when available ──
  // const res = await authFetch(`${API}/execute`, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({ prompt, agent_id: agentId, context_files: contextFiles, project_context: projectContext }),
  // });
  // if (!res.ok) throw new Error(await res.text());
  // return res.json();

  await delay(2000);

  return {
    trace_id: `trace-${uuid().slice(0, 12)}`,
    request_id: `req-${uuid().slice(0, 10)}`,
    answer: `## Generated Project — Task Manager API

Based on your spec, the **${agentId}** agent has generated a complete project scaffold.

### Project Structure
\`\`\`
task-manager/
├── app.py
├── models.py
├── routes.py
└── requirements.txt
\`\`\`

### How to Run
1. Install dependencies: \`pip install -r requirements.txt\`
2. Start server: \`python app.py\`
3. API available at \`http://localhost:8000\`

### Features Implemented
- FastAPI application with CORS support
- SQLAlchemy models for Task and User
- CRUD endpoints for task management
- Input validation with Pydantic schemas`,
    plan: {
      reasoning: `The ${agentId} agent analyzed the spec and determined a Python/FastAPI stack is optimal for this task management API. Sequential execution ensures proper dependency resolution.`,
      execution_mode: "sequential",
      subtasks: [
        {
          id: 1,
          description: "Generate project scaffold with backend API, models, and routes.",
          suggested_tools: ["project_scaffolder"],
          depends_on: [],
        },
      ],
    },
    subtask_results: [
      {
        id: 1,
        description: "Generate project scaffold with backend API, models, and routes.",
        success: true,
        output: {
          project_name: "task-manager",
          summary: "A task management API with FastAPI, SQLAlchemy, and Pydantic validation.",
          folders: ["task-manager"],
          files: [
            {
              path: "task-manager/app.py",
              language: "python",
              purpose: "FastAPI application entry point with CORS and route registration.",
              content: `from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes import router

app = FastAPI(title="Task Manager API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api/v1")


@app.get("/health")
def health_check():
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
`,
              bytes: 487,
              valid: true,
              error: null,
            },
            {
              path: "task-manager/models.py",
              language: "python",
              purpose: "SQLAlchemy data models for Task and User entities.",
              content: `from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship, sessionmaker
from datetime import datetime

Base = declarative_base()
engine = create_engine("sqlite:///tasks.db", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, nullable=False)
    full_name = Column(String(255), nullable=False)
    tasks = relationship("Task", back_populates="owner")


class Task(Base):
    __tablename__ = "tasks"
    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    description = Column(String(1000))
    completed = Column(Boolean, default=False)
    owner_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    owner = relationship("User", back_populates="tasks")


Base.metadata.create_all(bind=engine)
`,
              bytes: 892,
              valid: true,
              error: null,
            },
            {
              path: "task-manager/routes.py",
              language: "python",
              purpose: "API route handlers for task CRUD operations.",
              content: `from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from models import Task, SessionLocal

router = APIRouter(tags=["tasks"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class TaskCreate(BaseModel):
    title: str
    description: Optional[str] = None
    owner_id: int


class TaskResponse(BaseModel):
    id: int
    title: str
    description: Optional[str]
    completed: bool
    owner_id: int

    class Config:
        orm_mode = True


@router.get("/tasks", response_model=List[TaskResponse])
def list_tasks(db: Session = Depends(get_db)):
    return db.query(Task).all()


@router.post("/tasks", response_model=TaskResponse, status_code=201)
def create_task(task: TaskCreate, db: Session = Depends(get_db)):
    db_task = Task(**task.dict())
    db.add(db_task)
    db.commit()
    db.refresh(db_task)
    return db_task


@router.patch("/tasks/{task_id}", response_model=TaskResponse)
def toggle_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    task.completed = not task.completed
    db.commit()
    db.refresh(task)
    return task


@router.delete("/tasks/{task_id}", status_code=204)
def delete_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    db.delete(task)
    db.commit()
`,
              bytes: 1342,
              valid: true,
              error: null,
            },
            {
              path: "task-manager/requirements.txt",
              language: "plaintext",
              purpose: "Python package dependencies.",
              content: `fastapi==0.104.1
uvicorn==0.24.0
sqlalchemy==2.0.23
pydantic==2.5.2
`,
              bytes: 74,
              valid: true,
              error: null,
            },
          ],
        },
      },
    ],
  };
}
