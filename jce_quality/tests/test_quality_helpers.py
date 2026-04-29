import unittest

import frappe

from jce_quality.services.quality import get_required_check_count, summary_meets_requirements


class TestQualityHelpers(unittest.TestCase):
	def test_required_check_count_respects_optional_rules(self):
		optional_rule = frappe._dict(is_mandatory=0, minimum_patrol_count=3)
		mandatory_rule = frappe._dict(is_mandatory=1, minimum_patrol_count=3)

		self.assertEqual(get_required_check_count(optional_rule, "Patrol"), 0)
		self.assertEqual(get_required_check_count(mandatory_rule, "Patrol"), 3)
		self.assertEqual(get_required_check_count(None, "Patrol"), 1)
		self.assertEqual(get_required_check_count(None, "First Article"), 1)

	def test_summary_meets_requirements_uses_patrol_count(self):
		summary = {
			"frozen": False,
			"patrol_count": 2,
			"first_article_status": "Accepted",
			"last_article_status": "Accepted",
			"final_release_status": "Accepted",
		}

		self.assertTrue(
			summary_meets_requirements(
				summary,
				{"First Article": 1, "Patrol": 2, "Last Article": 1, "Final Release": 1},
			)
		)
		self.assertFalse(
			summary_meets_requirements(
				summary,
				{"First Article": 1, "Patrol": 3, "Last Article": 1, "Final Release": 1},
			)
		)

	def test_frozen_summary_never_meets_requirements(self):
		self.assertFalse(
			summary_meets_requirements(
				{
					"frozen": True,
					"patrol_count": 10,
					"first_article_status": "Accepted",
					"last_article_status": "Accepted",
					"final_release_status": "Accepted",
				},
				{"First Article": 0, "Patrol": 0, "Last Article": 0, "Final Release": 0},
			)
		)
