from rest_framework.routers import DefaultRouter

from .views import (
    CalendarView,
    ChangePasswordView,
    CommitmentViewSet,
    ConnectorRequestView,
    ConnectorResetView,
    ConnectorStatusView,
    CsrfTokenView,
    DecisionViewSet,
    FileMetadataConfirmView,
    FileMetadataView,
    GlobalChatView,
    MessageFeedbackView,
    GlobalSearchView,
    GlobalMetadataCsvView,
    GlobalSourcesView,
    GlobalTimelineView,
    LoginView,
    LogoutView,
    LoopViewSet,
    MeView,
    MeetingDetailView,
    OpenSourceFileView,
    OpenSourceFolderView,
    OrientHtmlView,
    OrientView,
    PasswordResetConfirmView,
    PasswordResetRequestView,
    RecordingEventViewSet,
    RegisterView,
    ResolveOnlyView,
    RiskViewSet,
    SearchLogView,
    SettingsUnlockView,
    SettingsView,
    AutoCreateTopicView,
    StatsView,
    TopicBriefHtmlView,
    TopicNamesView,
    TaskViewSet,
    TopicViewSet,
    UpdateProfileView,
)
from django.urls import path

router = DefaultRouter()
router.register("topics", TopicViewSet, basename="topic")
router.register("tasks", TaskViewSet, basename="task")
router.register("commitments", CommitmentViewSet, basename="commitment")
router.register("decisions", DecisionViewSet, basename="decision")
router.register("risks", RiskViewSet, basename="risk")
router.register("loops", LoopViewSet, basename="loop")
router.register("recording_events", RecordingEventViewSet, basename="recording-event")

urlpatterns = [
    # Must come before router.urls - "topics/auto_create/" would otherwise
    # match the router's own "topics/<pk>/" detail route first, with
    # pk="auto_create" (a real routing conflict, not a hypothetical one -
    # confirmed by checking the router's actual regex, which anchors with a
    # trailing $ right after the pk segment).
    path("topics/auto_create/", AutoCreateTopicView.as_view(), name="topic-auto-create"),
] + router.urls + [
    path("settings/", SettingsView.as_view(), name="settings"),
    path("settings/unlock/", SettingsUnlockView.as_view(), name="settings-unlock"),
    path("calendar/", CalendarView.as_view(), name="calendar"),
    path("orient/", OrientView.as_view(), name="orient"),
    path("resolve_only/", ResolveOnlyView.as_view(), name="resolve-only"),
    path("orient_html/", OrientHtmlView.as_view(), name="orient-html"),
    path("topics/<int:pk>/brief_html/", TopicBriefHtmlView.as_view(), name="topic-brief-html"),
    path("topic_names/", TopicNamesView.as_view(), name="topic-names"),
    path("files/<int:pk>/open/", OpenSourceFileView.as_view(), name="open-source-file"),
    path("files/<int:pk>/metadata/", FileMetadataView.as_view(), name="file-metadata"),
    path("files/<int:pk>/confirm/", FileMetadataConfirmView.as_view(), name="file-metadata-confirm"),
    path("meetings/<int:pk>/", MeetingDetailView.as_view(), name="meeting-detail"),
    path("metadata_csv/", GlobalMetadataCsvView.as_view(), name="global-metadata-csv"),
    path("folders/<int:pk>/open/", OpenSourceFolderView.as_view(), name="open-source-folder"),
    path("stats/", StatsView.as_view(), name="stats"),
    path("chat/global/", GlobalChatView.as_view(), name="global-chat"),
    path("messages/<str:kind>/<int:pk>/feedback/", MessageFeedbackView.as_view(), name="message-feedback"),
    path("search/", GlobalSearchView.as_view(), name="global-search"),
    path("search/log/", SearchLogView.as_view(), name="search-log"),
    path("sources/", GlobalSourcesView.as_view(), name="global-sources"),
    path("timeline/", GlobalTimelineView.as_view(), name="global-timeline"),
    path("connectors/", ConnectorStatusView.as_view(), name="connector-status"),
    path("connectors/<str:slug>/request/", ConnectorRequestView.as_view(), name="connector-request"),
    path("connectors/<str:slug>/reset/", ConnectorResetView.as_view(), name="connector-reset"),
    path("auth/csrf/", CsrfTokenView.as_view(), name="auth-csrf"),
    path("auth/login/", LoginView.as_view(), name="auth-login"),
    path("auth/register/", RegisterView.as_view(), name="auth-register"),
    path("auth/password_reset/request/", PasswordResetRequestView.as_view(), name="auth-password-reset-request"),
    path("auth/password_reset/confirm/", PasswordResetConfirmView.as_view(), name="auth-password-reset-confirm"),
    path("auth/logout/", LogoutView.as_view(), name="auth-logout"),
    path("auth/me/", MeView.as_view(), name="auth-me"),
    path("auth/change_password/", ChangePasswordView.as_view(), name="auth-change-password"),
    path("auth/update_profile/", UpdateProfileView.as_view(), name="auth-update-profile"),
]
