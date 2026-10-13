# Pengaturan, bahasa, tema, dan integrasi MCP

## Membuka pengaturan

Tombol pengaturan di kiri bawah Beranda membuka panel pengaturan. Panel ini punya lima bagian: Model AI, Media dan pencarian, Umum, Integrasi, dan Tentang.

![Pengaturan ▸ Umum, tempat bahasa, tema, Autosave, dan sakelar statistik penggunaan berada](img/settings-general.png)

Konfigurasi model punya bab tersendiri; di **Media & Pencarian AI** Anda menyalakan pembuatan gambar, analisis gambar, analisis video, pencarian web, dan pencarian file lokal untuk tiap penyedia.

## Bahasa

- Pengaturan menawarkan **21 bahasa antarmuka**: Inggris, Tionghoa Sederhana, Jepang, Korea, Prancis, Jerman, Spanyol, Thai, Indonesia, Rusia, Arab, Portugis, Italia, Polandia, Ceko, Belanda, Melayu, Ibrani, Hindi, Tionghoa Tradisional, Vietnam.
- Beralih bahasa berlaku seketika dan bertahan; bilah menu sistem dibangun ulang mengikuti bahasa tersebut.

## Tema

Terang / Gelap / Ikuti Sistem. Mode Ikuti Sistem mengikuti tampilan sistem operasi, dan para editor mengganti tema senada tanpa berkedip.

## Umum

- **Posisi bilah samping AI** (kiri atau kanan), **Ukuran teks panel AI** dan **Pemeriksaan ejaan di obrolan AI**.
- **Buka panel AI di dokumen baru** — nonaktif, dokumen baru dimulai dengan panel tertutup, sekali klik lagi.
- **Simpan otomatis semua dokumen** menyalakan AutoSave secara default di setiap editor; Anda tetap bisa mematikannya untuk satu jendela.
- **Lokasi penyimpanan** dengan tombol **Ubah**, dan **Aplikasi default untuk dokumen Office** untuk mengambil alih .docx / .xlsx / .pptx bagi TeleOffice.

## Media & Pencarian AI

Bukan sakelar — setiap kemampuan memilih vendor yang melayaninya, dan kunci serta URL dasar sebuah vendor cukup diisi sekali lalu dipakai bersama:

- **Pencarian web**, **Pembuatan gambar**, **Analisis gambar** dan **Analisis video**, masing-masing dengan satu provider, satu model, satu kunci, dan satu URL dasar.
- **Pencarian file lokal** berjalan di mesin ini. Di bawahnya ada **Peringkat ulang Jev** yang **nonaktif secara bawaan**. Aktifkan dan kutipan 20 hasil lokal teratas — hingga 1.200 karakter dari tiap dokumen, ditambah nama file dan foldernya — dikirim ke model Jev dari TypeSafe untuk diurutkan ulang berdasarkan relevansi. Saat nonaktif, tidak ada yang meninggalkan perangkat.

## Tentang

- **Versi**, tautan GitHub proyek, dan tombol **Beri Bintang di GitHub**.
- **Saluran Pembaruan**: Stabil atau Beta. Mengubahnya langsung berlaku dan memeriksa pembaruan; ini tidak akan menurunkan instalasi Beta kembali ke Stabil.

## Pengikatan aplikasi predefinida

Pengaturan dapat mendaftarkan TeleOffice sebagai aplikasi penangan .docx / .xlsx / .pptx / .pdf dan sejenisnya (pendaftaran aplikasi predefinida tingkat sistem; konfirmasi saat diminta).

## Pemberitahuan pihak ketiga dan pembaruan

- Bantuan ▸ Pemberitahuan Perangkat Lunak Pihak Ketiga: inventaris lengkap lisensi OSS yang disertakan dengan aplikasi.
- Bantuan ▸ Periksa Pembaruan…: memicu pemeriksaan manual; versi yang lebih baru menawarkan dipasang.

## Integrasi MCP (untuk pengguna lanjutan / klien AI)

**Integrasi** adalah panel yang menghubungkan TeleOffice dengan agen pemrograman, dan ia punya artikel tersendiri: Menghubungkan agen pemrograman. Versi singkat — pilih jalurnya (baris perintah, atau MCP), ikuti bagian itu, lalu mulai obrolan baru dan bertanya.

![Pengaturan ▸ Integrasi: tiga langkah, lalu baris skill dan opsi MCP](img/settings-integrations.png)

Di bawah **Server HTTP lokal**, aplikasi juga bisa menjalankan server itu sendiri — sakelar aktif dan port — dan **Lanjutan** menambahkan URL pemeriksaan kesehatan serta file log, alih-alih menghandalkannya kepada asisten. Ia hanya mendengarkan di localhost.

## Lembar pintasan baris perintah

| Perintah            | Fungsinya                |
| ------------------- | ------------------------ |
| `teleoffice <file>` | membuka sebuah file      |
| `teleoffice mcp`    | memulai server MCP lokal |
| `teleoffice --help` | semua perintah dan opsi  |
