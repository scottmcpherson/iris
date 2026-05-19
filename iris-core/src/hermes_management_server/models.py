"""Response models for Iris Core APIs."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ErrorResponse(BaseModel):
    ok: bool = False
    error: str


class HealthResponse(BaseModel):
    ok: bool = True
    checkedAt: int
    service: str = "iris-core"
    version: str
    pid: int
    managed: bool | None = None
    bindHost: str
    port: int
    hermesHome: str
    profilesRootExists: bool


class StatusResponse(BaseModel):
    ok: bool = True
    checkedAt: int
    hermesHome: str
    activeProfile: str
    profileCount: int
    core: dict[str, Any] = Field(default_factory=dict)


class ProfileSummary(BaseModel):
    name: str
    path: str
    active: bool
    exists: bool
    provider: str
    model: str
    memoryBytes: int
    memoryUpdatedAt: int | None
    skillCount: int
    gatewayRunning: bool


class AgentCreateRequest(BaseModel):
    name: str
    runtimeId: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class AgentRenameRequest(BaseModel):
    name: str


class AgentMemorySaveRequest(BaseModel):
    content: str
    expectedUpdatedAt: int | None = None


class AgentMemoryResetRequest(BaseModel):
    confirm: str = ""


class AgentSkillSaveRequest(BaseModel):
    name: str = ""
    category: str = "personal"
    path: str = ""
    content: str = ""


class FileContent(BaseModel):
    name: str
    path: str
    exists: bool
    updatedAt: int | None
    bytes: int
    content: str


class SkillSummary(BaseModel):
    id: str
    name: str
    path: str
    category: str
    description: str
    updatedAt: int | None
    source: str
    version: str | None
    tags: list[str] = Field(default_factory=list)
    bytes: int
    metadata: dict[str, Any] = Field(default_factory=dict)


class CoreSessionCreateRequest(BaseModel):
    agentId: str | None = None
    title: str = "New session"
    externalChatId: str | None = None
    externalSessionId: str | None = None
    projectId: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class CoreSessionUpdateRequest(BaseModel):
    title: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SessionReadStateUpdateRequest(BaseModel):
    state: str = "read"
    metadata: dict[str, Any] = Field(default_factory=dict)


class CoreMessageAttachmentRef(BaseModel):
    id: str


class CoreMessageCreateRequest(BaseModel):
    text: str
    attachments: list[CoreMessageAttachmentRef | dict[str, Any]] = Field(default_factory=list)
    model: dict[str, Any] | None = None
    clientMessageId: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectCreateRequest(BaseModel):
    name: str
    defaultAgentId: str
    systemPrompt: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectUpdateRequest(BaseModel):
    name: str | None = None
    defaultAgentId: str | None = None
    systemPrompt: str | None = None
    metadata: dict[str, Any] | None = None


class ProjectSessionLinkRequest(BaseModel):
    sessionId: str


class DeviceCursorUpdateRequest(BaseModel):
    streamName: str = "global"
    lastCursor: int


class DevicePairRequest(BaseModel):
    name: str = "Iris device"
    kind: str = "desktop"
    metadata: dict[str, Any] = Field(default_factory=dict)


class RuntimeDeliveryHermesRequest(BaseModel):
    runtimeId: str = "runtime_local_hermes"
    profile: str = "default"
    chatId: str
    messageId: str
    replyTo: str | None = None
    source: str = "hermes-gateway-stream"
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class CoreAutomationCreateRequest(BaseModel):
    agentId: str
    name: str = "Iris reminder"
    schedule: str
    prompt: str
    repeat: int | None = None
    deliver: str | None = None
    deliverToSessionId: str | None = None
    projectId: str | None = None


class CoreAutomationUpdateRequest(BaseModel):
    name: str | None = None
    schedule: str | None = None
    prompt: str | None = None
    repeat: int | None = None
    deliver: str | None = None
    deliverToSessionId: str | None = None
    projectId: str | None = None
    status: str | None = None


class SessionSummary(BaseModel):
    id: str
    source: str
    model: str
    title: str
    preview: str
    chatId: str | None = None
    origin: dict[str, Any] = Field(default_factory=dict)
    startedAt: int | None
    endedAt: int | None
    lastActiveAt: int | None
    messageCount: int


class SessionMessage(BaseModel):
    id: str
    sessionId: str
    role: str
    content: str
    toolName: str = ""
    toolCallId: str = ""
    toolCalls: list[dict[str, Any]] = Field(default_factory=list)
    timestamp: int | None
