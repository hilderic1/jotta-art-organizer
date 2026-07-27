import SparkMD5 from 'spark-md5'

const CHUNK_SIZE = 2 * 1024 * 1024

export function hashFileMd5(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const spark = new SparkMD5.ArrayBuffer()
    const reader = new FileReader()
    let offset = 0

    function readNextChunk() {
      const slice = file.slice(offset, offset + CHUNK_SIZE)
      reader.readAsArrayBuffer(slice)
    }

    reader.onload = (e) => {
      spark.append(e.target?.result as ArrayBuffer)
      offset += CHUNK_SIZE
      if (offset < file.size) {
        readNextChunk()
      } else {
        resolve(spark.end())
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file for hashing.'))

    readNextChunk()
  })
}
