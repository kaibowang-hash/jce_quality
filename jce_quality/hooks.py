app_name = "jce_quality"
app_title = "JCE Quality"
app_publisher = "JCE"
app_description = "Production quality control for ERPNext"
app_email = "kaibo_wang@whjichen.cn"
app_license = "mit"

# Apps
# ------------------

# required_apps = []

# Each item in the list will be shown as an app in the apps page
# add_to_apps_screen = [
# 	{
# 		"name": "jce_quality",
# 		"logo": "/assets/jce_quality/logo.png",
# 		"title": "JCE Quality",
# 		"route": "/jce_quality",
# 		"has_permission": "jce_quality.api.permission.has_app_permission"
# 	}
# ]

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
# app_include_css = "/assets/jce_quality/css/jce_quality.css"
# app_include_js = "/assets/jce_quality/js/jce_quality.js"

# include js, css files in header of web template
# web_include_css = "/assets/jce_quality/css/jce_quality.css"
# web_include_js = "/assets/jce_quality/js/jce_quality.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "jce_quality/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
# doctype_js = {"doctype" : "public/js/doctype.js"}
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Svg Icons
# ------------------
# include app icons in desk
# app_include_icons = "jce_quality/public/icons.svg"

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# automatically load and sync documents of this doctype from downstream apps
# importable_doctypes = [doctype_1]

# Jinja
# ----------

# add methods and filters to jinja environment
# jinja = {
# 	"methods": "jce_quality.utils.jinja_methods",
# 	"filters": "jce_quality.utils.jinja_filters"
# }

# Installation
# ------------

# before_install = "jce_quality.install.before_install"
# after_install = "jce_quality.install.after_install"

# Uninstallation
# ------------

# before_uninstall = "jce_quality.uninstall.before_uninstall"
# after_uninstall = "jce_quality.uninstall.after_uninstall"

# Integration Setup
# ------------------
# To set up dependencies/integrations with other apps
# Name of the app being installed is passed as an argument

# before_app_install = "jce_quality.utils.before_app_install"
# after_app_install = "jce_quality.utils.after_app_install"

# Integration Cleanup
# -------------------
# To clean up dependencies/integrations with other apps
# Name of the app being uninstalled is passed as an argument

# before_app_uninstall = "jce_quality.utils.before_app_uninstall"
# after_app_uninstall = "jce_quality.utils.after_app_uninstall"

# Build
# ------------------
# To hook into the build process

# after_build = "jce_quality.build.after_build"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "jce_quality.notifications.get_notification_config"

# Permissions
# -----------
# Permissions evaluated in scripted ways

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
# 	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

# Document Events
# ---------------
# Hook on document methods and events

# doc_events = {
# 	"*": {
# 		"on_update": "method",
# 		"on_cancel": "method",
# 		"on_trash": "method"
# 	}
# }

# Scheduled Tasks
# ---------------

# scheduler_events = {
# 	"all": [
# 		"jce_quality.tasks.all"
# 	],
# 	"daily": [
# 		"jce_quality.tasks.daily"
# 	],
# 	"hourly": [
# 		"jce_quality.tasks.hourly"
# 	],
# 	"weekly": [
# 		"jce_quality.tasks.weekly"
# 	],
# 	"monthly": [
# 		"jce_quality.tasks.monthly"
# 	],
# }

# Testing
# -------

# before_tests = "jce_quality.install.before_tests"

# Extend DocType Class
# ------------------------------
#
# Specify custom mixins to extend the standard doctype controller.
# extend_doctype_class = {
# 	"Task": "jce_quality.custom.task.CustomTaskMixin"
# }

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
# 	"frappe.desk.doctype.event.event.get_events": "jce_quality.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "jce_quality.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Ignore links to specified DocTypes when deleting documents
# -----------------------------------------------------------

# ignore_links_on_delete = ["Communication", "ToDo"]

# Request Events
# ----------------
# before_request = ["jce_quality.utils.before_request"]
# after_request = ["jce_quality.utils.after_request"]

# Job Events
# ----------
# before_job = ["jce_quality.utils.before_job"]
# after_job = ["jce_quality.utils.after_job"]

# User Data Protection
# --------------------

# user_data_fields = [
# 	{
# 		"doctype": "{doctype_1}",
# 		"filter_by": "{filter_by}",
# 		"redact_fields": ["{field_1}", "{field_2}"],
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_2}",
# 		"filter_by": "{filter_by}",
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_3}",
# 		"strict": False,
# 	},
# 	{
# 		"doctype": "{doctype_4}"
# 	}
# ]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
# 	"jce_quality.auth.validate"
# ]

# Automatically update python controller files with type annotations for this app.
# export_python_type_annotations = True

# default_log_clearing_doctypes = {
# 	"Logging DocType Name": 30  # days to retain logs
# }

# Translation
# ------------
# List of apps whose translatable strings should be excluded from this app's translations.
# ignore_translatable_strings_from = []

required_apps = ["erpnext", "zelin_pp"]

doctype_js = {
	"Work Order Scheduling": "public/js/work_order_scheduling.js",
}

after_install = "jce_quality.install.after_install"
after_migrate = "jce_quality.install.after_migrate"

doc_events = {
	"Stock Entry": {
		"before_submit": "jce_quality.services.quality.validate_stock_entry_quality_gate",
	},
}

scheduler_events = {
	"cron": {
		"*/15 * * * *": [
			"jce_quality.services.reminders.scan_patrol_reminders",
		],
	},
}

override_whitelisted_methods = {
	"zelin_pp.planning_enhancement.doctype.work_order_scheduling.work_order_scheduling.create_stock_entry": "jce_quality.overrides.work_order_scheduling.create_stock_entry",
}
