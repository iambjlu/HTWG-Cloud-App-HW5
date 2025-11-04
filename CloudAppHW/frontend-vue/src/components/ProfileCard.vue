<script setup>
import { ref, watch, onMounted } from 'vue'
import axios from 'axios'

const props = defineProps({
  userEmail: {
    type: String,
    required: true
  },
  currentUserEmail: {
    // 登入者 email（用來判斷是不是本人，可以上傳頭貼）
    type: String,
    required: true
  }
})

// 大頭貼 URL
const avatarUrl = ref('')

// 初始化/當 email 改變時，更新頭貼 URL
function updateAvatarUrl() {
  if (!props.userEmail) {
    avatarUrl.value = 'https://storage.googleapis.com/htwg-cloudapp-hw.firebasestorage.app/avatar/default.jpg'
    return
  }
  // 加上 timestamp 破 cache
  const ts = Date.now()
  avatarUrl.value =
      `https://storage.googleapis.com/htwg-cloudapp-hw.firebasestorage.app/avatar/${props.userEmail}.jpg?ts=${ts}`
}

onMounted(updateAvatarUrl)
watch(() => props.userEmail, updateAvatarUrl)

function onAvatarError() {
  avatarUrl.value = 'https://storage.googleapis.com/htwg-cloudapp-hw.firebasestorage.app/avatar/default.jpg'
}

// ====================
//  上傳頭貼流程
// ====================

// 用來觸發 <input type="file" hidden>
const fileInputRef = ref(null)

// 點頭貼時觸發
function handleAvatarClick() {
  // 只有本人可以改自己的頭貼
  if (props.userEmail !== props.currentUserEmail) return
  fileInputRef.value?.click()
}

// 讀檔 -> 壓縮 -> 丟到後端
async function handleFileChange(e) {
  const file = e.target.files[0]
  if (!file) return

  // 僅允許 jpg
  if (
      file.type !== 'image/jpeg' &&
      file.type !== 'image/jpg' &&
      !file.name.toLowerCase().endsWith('.jpg') &&
      !file.name.toLowerCase().endsWith('.jpeg')&&
      file.type !== 'image/png' &&
      !file.name.toLowerCase().endsWith('.png')
  ) {
    alert('Only .jpg/.jpeg/.png is allowed')
    return
  }

  try {

    // 壓縮到 200x200, 品質 0.85
    const blob = await resizeToJpegBlob(file, 200, 200, 0.85)

    // 丟到後端
    const formData = new FormData()
    formData.append('avatar', blob, 'avatar.jpg')
    formData.append('email', props.currentUserEmail)

    await axios.post(
        `${import.meta.env.VITE_API_BASE_URL}/api/upload-avatar`,
        formData,
        {
          headers: { 'Content-Type': 'multipart/form-data' }
        }
    )

    // 成功 -> 重新載入頭貼 (破 cache)
    updateAvatarUrl()
    alert('Avatar updated ✨')
  } catch (err) {
    console.error(err)
    alert('Upload failed')
  } finally {
    // reset input value so you can re-upload same file again if needed
    e.target.value = ''
  }
}

// 把任意圖片壓成固定寬高 jpeg blob
function resizeToJpegBlob(file, targetW, targetH, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      // 建立 canvas
      const canvas = document.createElement('canvas')
      canvas.width = targetW
      canvas.height = targetH

      const ctx = canvas.getContext('2d')

      // 我們要等比縮放 + 居中裁切，讓結果變成剛好 200x200 正方形
      // 步驟：
      // 1. 算原圖等比縮放後，哪個邊貼滿 200
      const ratio = Math.max(targetW / img.width, targetH / img.height)
      const newW = img.width * ratio
      const newH = img.height * ratio

      // 2. 把縮放後的圖畫在 canvas 的中心，超出的邊會被裁掉
      const dx = (targetW - newW) / 2
      const dy = (targetH - newH) / 2

      ctx.fillStyle = '#ffffff' // 背景白（避免透明變黑）
      ctx.fillRect(0, 0, targetW, targetH)
      ctx.drawImage(img, dx, dy, newW, newH)

      // 3. 匯出 JPEG blob
      canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Canvas toBlob failed'))
              return
            }
            resolve(blob)
          },
          'image/jpeg',
          quality
      )
    }
    img.onerror = reject

    // 把檔案讀進 <img>
    const reader = new FileReader()
    reader.onload = (ev) => {
      img.src = ev.target.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
</script>

<template>
  <div
      class="bg-white p-6 rounded-xl shadow-lg border border-gray-200 flex flex-col items-center text-center"
  >
    <!-- 隱藏 input -->
    <input
        type="file"
        accept="image/jpeg,image/jpg,image/png"
        ref="fileInputRef"
        class="hidden"
        @change="handleFileChange"
    />

    <!-- 頭貼外層（控制 hover 效果） -->
    <div
        class="relative group w-[100px] h-[100px]"
        @click="handleAvatarClick"
    >
      <!-- 頭貼 -->
      <img
          :src="avatarUrl"
          @error="onAvatarError"
          class="w-full h-full rounded-full object-cover border border-gray-300 shadow-sm cursor-pointer select-none"
          :class="{
          'ring-2 ring-indigo-500 hover:ring-indigo-600 transition':
            userEmail === currentUserEmail
        }"
          alt="User Avatar"
      />

      <!-- hover 時出現半透明層 + 筆 icon -->
      <div
          v-if="userEmail === currentUserEmail"
          class="absolute inset-0 bg-black/40 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition duration-100 cursor-pointer"
      >
        <!-- 筆 icon -->
        <svg
            xmlns="http://www.w3.org/2000/svg"
            class="w-6 h-6 text-white"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
        >
          <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652l-9.193 9.193a4.5 4.5 0 01-1.897 1.13l-3.261.977a.375.375 0 01-.465-.465l.977-3.26a4.5 4.5 0 011.13-1.898l9.193-9.193z"
          />
        </svg>
      </div>
    </div>

    <p class="text-sm text-gray-500 mt-2">user</p>
    <p class="text-lg font-semibold text-gray-800 break-all">{{ userEmail }}</p>

    <!--    <p-->
    <!--        v-if="userEmail === currentUserEmail"-->
    <!--        class="text-[11px] text-indigo-500 mt-2"-->
    <!--    >-->
    <!--      Click avatar to upload JPG-->
    <!--    </p>-->
  </div>
</template>