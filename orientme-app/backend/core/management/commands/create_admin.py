from django.contrib.auth.models import User
from django.core.management.base import BaseCommand

from core.models import Profile


class Command(BaseCommand):
    """Creates (or upgrades) one login with role='admin' - the one manual
    setup step every login-gated environment needs and nothing in this repo
    previously documented or automated. A plain `createsuperuser` alone
    isn't enough: this app has no signal wiring a Profile row to every new
    User, so a superuser created that way still reads back as role='user'
    from _profile_payload's own graceful-default behavior (see views.py)
    and can't reach admin-only actions like Settings' API key field.

    Usage: python manage.py create_admin --username admin --password change-me
    """

    help = "Creates or upgrades a login to role='admin' (Profile + User in one step)."

    def add_arguments(self, parser):
        parser.add_argument("--username", required=True)
        parser.add_argument("--password", required=True)

    def handle(self, *args, **options):
        username = options["username"]
        password = options["password"]

        user, created = User.objects.get_or_create(username=username)
        user.set_password(password)
        user.is_staff = True
        user.save()

        profile, _ = Profile.objects.get_or_create(user=user)
        profile.role = "admin"
        profile.save()

        verb = "Created" if created else "Updated"
        self.stdout.write(self.style.SUCCESS(f"{verb} admin login: {username}"))
