import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw
from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.processor import Cancelled, key, page_selection, register_fonts, simplify


class ProcessorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        register_fonts()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def create(self, pages):
        target = self.root / 'fixture.pdf'
        canvas = Canvas(str(target), pagesize=(960, 540))
        for rows in pages:
            y = 500
            for text in rows:
                canvas.setFont('Handout', 20)
                canvas.drawString(70, y, text)
                y -= 50
            canvas.showPage()
        canvas.save()
        return target

    def run_file(self, source, reporter=lambda *args: None):
        data, stats = simplify(source, self.root / 'result', {
            'layout': 'balanced', 'background': 'text-only', 'sourceMode': 'none',
        }, reporter)
        text = ''.join(p.extract_text() for p in PdfReader(self.root / 'result/handout.pdf').pages)
        return data, stats, ''.join(text.split())

    def test_progressive_pages_preserve_new_conditions_and_regroup(self):
        source = self.create([
            ['第一章 合同', '一、效力', '1. 有效条件', '条件为甲和乙。', '2. 其他条件', '金额为100元。'],
            ['第一章 合同', '一、效力', '1. 有效条件', '条件为甲和乙。', '但不得推定丙已经同意。'],
        ])
        data, stats, text = self.run_file(source)
        self.assertIn('但不得推定丙已经同意。', text)
        self.assertIn('金额为100元。', text)
        self.assertEqual(text.count('条件为甲和乙。'), 1)
        self.assertLess(text.index('但不得推定丙已经同意。'), text.index('金额为100元。'))
        self.assertGreater(stats['removed_headings'], 0)
        self.assertEqual(stats['removed_paragraphs'], 1)
        self.assertNotIn('来源：', text)

    def test_same_heading_in_different_chapters_stays_separate(self):
        source = self.create([
            ['第一章 合同', '一、概念', '相同表述也必须保留。', '甲章条件是不得超过100元。'],
            ['第二章 侵权', '一、概念', '相同表述也必须保留。', '乙章条件是不低于200元。'],
        ])
        data, stats, text = self.run_file(source)
        self.assertEqual(text.count('相同表述也必须保留。'), 2)
        self.assertIn('不得超过100元', text)
        self.assertIn('不低于200元', text)
        self.assertEqual(stats['removed_paragraphs'], 0)

    def test_scanned_page_preserves_bottom_edge(self):
        image = Image.new('RGB', (960, 540), 'white')
        ImageDraw.Draw(image).rectangle((0, 520, 959, 539), fill='red')
        picture = self.root / 'scan.png'
        image.save(picture)
        source = self.root / 'scan.pdf'
        canvas = Canvas(str(source), pagesize=(960, 540))
        canvas.drawImage(str(picture), 0, 0, width=960, height=540)
        canvas.save()
        data, stats, text = self.run_file(source)
        self.assertEqual(stats['image_pages'], 1)
        asset = next(b['path'] for b in data['blocks'] if b['kind'] == 'image')
        retained = Image.open(asset)
        r, g, b = retained.getpixel((retained.width//2, retained.height-2))
        self.assertGreater(r, 220)
        self.assertLess(g, 30)
        self.assertLess(b, 30)
        retained.close()

    def test_cancellation_stops_before_output(self):
        source = self.create([['第一章 合同', '正文必须完整保留。']])
        def cancel(*args):
            raise Cancelled()
        with self.assertRaises(Cancelled):
            self.run_file(source, cancel)
        self.assertFalse((self.root / 'result/handout.pdf').exists())

    def test_ranges_and_english_word_boundaries(self):
        self.assertEqual(page_selection('5-7, 2', 9), [2, 5, 6, 7])
        for value in ('0', '8-2', '1-10', '2,', 'hello'):
            with self.assertRaises(ValueError):
                page_selection(value, 9)
        self.assertNotEqual(key('now here'), key('no where'))


if __name__ == '__main__':
    unittest.main()
