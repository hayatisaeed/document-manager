from django.urls import include, path, re_path

from core.views.spa import spa_index

urlpatterns = [
    path("api/", include("core.urls")),
    # Everything else is the React single-page app.
    re_path(r"^(?!api/|static/).*$", spa_index),
]
