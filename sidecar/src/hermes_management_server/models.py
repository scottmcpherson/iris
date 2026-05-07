"""Response models for Iris Core and Hermes compatibility APIs."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ErrorResponse(BaseModel):
    ok: bool = False
    error: str


class HealthResponse(BaseModel):
    ok: bool = True
    checkedAt: int
    hermesHome: str
    profilesRootExists: bool


class InboxHealthResponse(BaseModel):
    ok: bool = True
    checkedAt: int
    path: str


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


class ProfilesResponse(BaseModel):
    ok: bool = True
    hermesHome: str
    activeProfile: str
    profiles: list[ProfileSummary]


class ProfileResponse(ProfileSummary):
    ok: bool = True


class ProfileCreateRequest(BaseModel):
    name: str


class ProfileCloneRequest(BaseModel):
    name: str


class ProfileActionResponse(BaseModel):
    ok: bool = True
    profile: str
    profiles: list[ProfileSummary]


class InboxMessageCreateRequest(BaseModel):
    id: str | None = None
    source: str = "hermes-cron"
    platform: str = "agentui"
    profile: str = "default"
    chatId: str = "agentui"
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    createdAt: int | None = None


class InboxMessage(BaseModel):
    cursor: int
    id: str
    source: str
    platform: str
    profile: str
    chatId: str
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    createdAt: int
    acknowledgedAt: int | None = None


class InboxMessageResponse(BaseModel):
    ok: bool = True
    message: InboxMessage


class InboxMessagesResponse(BaseModel):
    ok: bool = True
    messages: list[InboxMessage] = Field(default_factory=list)
    cursor: int = 0


class FileContent(BaseModel):
    name: str
    path: str
    exists: bool
    updatedAt: int | None
    bytes: int
    content: str


class MemoryResponse(BaseModel):
    ok: bool = True
    profile: str
    path: str
    files: list[FileContent]
    memory: FileContent
    user: FileContent


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


class SkillsResponse(BaseModel):
    ok: bool = True
    profile: str
    path: str
    skills: list[SkillSummary]


class SkillDetailResponse(SkillSummary):
    ok: bool = True
    profile: str
    content: str


class CoreConversationCreateRequest(BaseModel):
    agentId: str
    title: str = "New conversation"
    externalChatId: str | None = None
    externalSessionId: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class CoreMessageCreateRequest(BaseModel):
    text: str
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    model: dict[str, Any] | None = None
    clientMessageId: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


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
    deliverToConversationId: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class CoreAutomationUpdateRequest(BaseModel):
    name: str | None = None
    schedule: str | None = None
    prompt: str | None = None
    repeat: int | None = None
    deliver: str | None = None
    deliverToConversationId: str | None = None
    status: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ConversationSummary(BaseModel):
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


class ConversationMessage(BaseModel):
    id: str
    sessionId: str
    role: str
    content: str
    toolName: str = ""
    toolCallId: str = ""
    toolCalls: list[dict[str, Any]] = Field(default_factory=list)
    timestamp: int | None


class ConversationsResponse(BaseModel):
    ok: bool = True
    profile: str
    path: str
    source: str = "hermes-management"
    schemaVersion: int | None
    conversations: list[ConversationSummary] = Field(default_factory=list)
    warning: str | None = None


class ConversationDetailResponse(BaseModel):
    ok: bool = True
    profile: str
    path: str
    source: str = "hermes-management"
    schemaVersion: int | None
    conversation: ConversationSummary
    messages: list[ConversationMessage] = Field(default_factory=list)
    warning: str | None = None
