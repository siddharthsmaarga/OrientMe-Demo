from rest_framework.routers import DefaultRouter

from .views import (
    CalendarView,
    ChangePasswordView,
    ConnectorRequestView,
    ConnectorResetView,
    ConnectorStatusView,
    CsrfTokenView,
    GlobalChatView,
    GlobalSearchView,
    LoginView,
    LogoutView,
    LoopViewSet,
    MeView,
    OpenSourceFileView,
    OrientHtmlView,
    OrientView,
    ResolveOnlyView,
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
router.register("loops", LoopViewSet, basename="loop")

urlpatterns = [
    # Must come before router.urls - "topics/auto_create/" would otherwise
    # match the router's own "topics/<pk>/" detail route first, with
    # pk="auto_create" (a real routing conflict, not a hypothetical one -
    # confirmed by checking the router's actual regex, which anchors with a
    # trailing $ right after the pk segment).
    path("topics/auto_create/", AutoCreateTopicView.as_view(), name="topic-auto-create"),
] + router.urls + [
    path("settings/", SettingsView.as_view(), name="settings"),
    path("calendar/", CalendarView.as_view(), name="calendar"),
    path("orient/", OrientView.as_view(), name="orient"),
    path("resolve_only/", ResolveOnlyView.as_view(), name="resolve-only"),
    path("orient_html/", OrientHtmlView.as_view(), name="orient-html"),
    path("topics/<int:pk>/brief_html/", TopicBriefHtmlView.as_view(), name="topic-brief-html"),
    path("topic_names/", TopicNamesView.as_view(), name="topic-names"),
    path("files/<int:pk>/open/", OpenSourceFileView.as_view(), name="open-source-file"),
    path("stats/", StatsView.as_view(), name="stats"),
    path("chat/global/", GlobalChatView.as_view(), name="global-chat"),
    path("search/", GlobalSearchView.as_view(), name="global-search"),
    path("connectors/", ConnectorStatusView.as_view(), name="connector-status"),
    path("connectors/<str:slug>/request/", ConnectorRequestView.as_view(), name="connector-request"),
    path("connectors/<str:slug>/reset/", ConnectorResetView.as_view(), name="connector-reset"),
    path("auth/csrf/", CsrfTokenView.as_view(), name="auth-csrf"),
    path("auth/login/", LoginView.as_view(), name="auth-login"),
    path("auth/logout/", LogoutView.as_view(), name="auth-logout"),
    path("auth/me/", MeView.as_view(), name="auth-me"),
    path("auth/change_password/", ChangePasswordView.as_view(), name="auth-change-password"),
    path("auth/update_profile/", UpdateProfileView.as_view(), name="auth-update-profile"),
]
