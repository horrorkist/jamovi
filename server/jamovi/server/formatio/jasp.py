
import zipfile
from zipfile import ZipFile
import io
import json
from tempfile import TemporaryDirectory
from tempfile import NamedTemporaryFile
import struct
import os
import os.path

from jamovi.core import DataType
from jamovi.core import MeasureType


def get_readers():
    return [ ( 'jasp', read ) ]


def write(data, path, prog_cb, **kwargs):

    with ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zip:
        content = io.StringIO()
        content.write('Manifest-Version: 1.0\n')
        content.write('Created-By: JASP 0.7.5 Beta 2\n')
        content.write('Data-Archive-Version: 1.0.2\n')
        content.write('JASP-Archive-Version: 2.0\n')
        zip.writestr('META-INF/MANIFEST.MF', bytes(content.getvalue(), 'utf-8'), zipfile.ZIP_DEFLATED)

        content = None

        fields = [ ]
        for column in data.dataset:
            field = { }
            field['name'] = column.name
            field['measureType'] = MeasureType.stringify(column.measure_type)
            if column.measure_type == MeasureType.CONTINUOUS:
                field['type'] = 'number'
            else:
                field['type'] = 'integer'
            fields.append(field)

        metadata = { }

        metadataset = { }
        metadataset['rowCount'] = data.dataset.row_count
        metadataset['columnCount'] = data.dataset.column_count
        metadataset['fields'] = fields

        metadata['dataSet'] = metadataset

        zip.writestr('metadata.json', json.dumps(metadata), zipfile.ZIP_DEFLATED)

        metadata = None

        xdata = { }
        for column in data.dataset:
            if column.has_levels:
                xdata[column.name] = { 'labels': column.levels }
        zip.writestr('xdata.json', json.dumps(xdata), zipfile.ZIP_DEFLATED)
        xdata = None

        row_count = data.dataset.row_count
        required_bytes = 0
        for column in data.dataset:
            if column.measure_type == MeasureType.CONTINUOUS:
                required_bytes += (8 * row_count)
            else:
                required_bytes += (4 * row_count)

        temp_file = NamedTemporaryFile(delete=False)
        temp_file.truncate(required_bytes)

        for column in data.dataset:
            if column.measure_type == MeasureType.CONTINUOUS:
                for i in range(0, row_count):
                    value = column.raw(i)
                    byts = struct.pack('<d', value)
                    temp_file.write(byts)
            else:
                for i in range(0, row_count):
                    value = column.raw(i)
                    byts = struct.pack('<i', value)
                    temp_file.write(byts)

        temp_file.close()

        zip.write(temp_file.name, 'data.bin')
        os.remove(temp_file.name)


def read(data, path, prog_cb, **kwargs):

    with ZipFile(path, 'r') as zip:
        # manifest = zip.read('META-INF/MANIFEST.MF')

        meta_content = zip.read('metadata.json').decode('utf-8')
        metadata = json.loads(meta_content)
        meta_dataset = metadata['dataSet']

        for meta_column in meta_dataset['fields']:
            data.append_column(meta_column['name'])
            column = data.dataset[data.dataset.column_count - 1]

            measure_type_str = meta_column['measureType']

            if measure_type_str == 'NominalText':
                data_type = DataType.TEXT
                measure_type = MeasureType.NOMINAL
            elif measure_type_str == 'Continuous':
                data_type = DataType.DECIMAL
                measure_type = MeasureType.CONTINUOUS
            else:
                data_type = DataType.INTEGER
                measure_type = MeasureType.parse(measure_type_str)

            column.change(data_type=data_type, measure_type=measure_type)

        row_count = meta_dataset['rowCount']

        data.dataset.set_row_count(row_count)

        try:
            xdata_content = zip.read('xdata.json').decode('utf-8')
            xdata = json.loads(xdata_content)

            for column in data.dataset:
                if column.name in xdata:
                    meta_labels = xdata[column.name]['labels']
                    for meta_label in meta_labels:
                        if column.data_type == DataType.TEXT:
                            # they index from 1 ... although i suppose that's on me
                            column.append_level(meta_label[0]-1, meta_label[1], str(meta_label[0]))
                        else:
                            column.append_level(meta_label[0], meta_label[1], str(meta_label[0]))
        except Exception:
            pass

        with TemporaryDirectory() as dir:
            zip.extract('data.bin', dir)
            data_path = os.path.join(dir, 'data.bin')
            data_file = open(data_path, 'rb')

            for column in data.dataset:
                if column.measure_type == MeasureType.CONTINUOUS:
                    for i in range(row_count):
                        byts = data_file.read(8)
                        value = struct.unpack('<d', byts)[0]
                        column.set_value(i, value)
                else:
                    for i in range(row_count):
                        byts = data_file.read(4)
                        value = struct.unpack('<i', byts)[0]
                        if column.data_type == DataType.TEXT:
                            column.set_value(i, value-1)
                        else:
                            column.set_value(i, value)
            data_file.close()

        for column in data.dataset:
            column.determine_dps()
