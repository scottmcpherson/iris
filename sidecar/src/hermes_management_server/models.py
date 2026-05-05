"""Response models for the Hermes management API."""

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


class StatusResponse(BaseModel):
    ok: bool = True
    checkedAt: int
    hermesHome: str
    activeProfile: str
    profileCount: int


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


class ConversationSummary(BaseModel):
    id: str
    source: str
    model: str
    title: str
    preview: str
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
