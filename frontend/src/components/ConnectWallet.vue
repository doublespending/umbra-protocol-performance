<template>
  <div @click="connectWalletWithRedirect">
    <slot></slot>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Router, useRouter } from 'vue-router';
import useWalletStore from 'src/store/wallet';

function useWallet(to: string, router: Router) {
  const { connectWallet, userAddress } = useWalletStore();

  async function connectWalletWithRedirect() {
    // If user already connected wallet, continue (this branch is used when clicking e.g. the "Send" box
    // from the home page)
    if (userAddress.value && to) {
      await router.push({ name: to });
      return;
    } else if (userAddress.value) {
      return;
    }

    await connectWallet();

    if (to) await router.push({ name: to }); // redirect to specified page
  }

  return { connectWalletWithRedirect };
}

export default defineComponent({
  name: 'ConnectWallet',

  props: {
    // Page name to redirect to after logging in
    to: {
      type: String,
      required: false,
      default: undefined,
    },
  },

  setup(props) {
    const router = useRouter();
    return { ...useWallet(props.to || 'home', router) };
  },
});
</script>
